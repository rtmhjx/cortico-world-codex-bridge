import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CODEX_NOTIFICATION_TEXT_CHARS=24000;
export const CODEX_ACTIVE_ROUTE_LIMIT=10000;

export interface ThreadCursor { identity:string; offset:number; }
export interface DeferredProgress {
  turnId?:string; cwd:string; from:number; to:number; items:number; firstAt:string; lastAt:string;
  counts:Record<string,number>; lastProgress?:{id:string;ts:string;text:string;offset:number;endOffset:number;truncated:boolean};
}
export interface NotificationRoute {
  terminal:boolean; finalHash?:string; completionSeen?:boolean; lastAt:string;
  importantHashes:Record<string,string>;
}
export interface ThreadNotifications {
  anonymousEpoch:number; routes:Record<string,NotificationRoute>;
}
export interface PendingBatch {
  text:string; meta:Record<string,unknown>; deferred:Record<string,DeferredProgress>; notifications:ThreadNotifications;
  deferredAdded:number; suppressed:number;
}
export interface PendingDelivery { identity:string; from:number; to:number; deliveryId:string; items:number; itemIds:string[]; batch?:PendingBatch }
export interface BridgeCheckpoint {
  version:1; scopeHash:string; updatedAt:string;
  threads:Record<string,ThreadCursor>;
  pushedEvents:number; pushedItems:number; polls:number; failures:number;
  lastPollAt:string|null; lastSuccessAt:string|null; lastError:{at:string;message:string}|null;
  pending?:Record<string,PendingDelivery>;
  deferred?:Record<string,Record<string,DeferredProgress>>;
  notifications?:Record<string,ThreadNotifications>;
  deferredItems?:number;
  suppressedTerminalItems?:number;
}

export class BridgeRuntime {
  readonly file:string;
  constructor(readonly dir:string,private readonly clock:()=>string) {
    mkdirSync(dir,{recursive:true});this.file=join(dir,'checkpoint.json');
  }
  load(scopeHash:string):BridgeCheckpoint|null {
    if(!existsSync(this.file))return null;
    let value:BridgeCheckpoint;
    try { value=JSON.parse(readFileSync(this.file,'utf8')); } catch { throw new Error('Bridge checkpoint is corrupt; preserve the file and recover it before restarting.'); }
    if(value.version!==1||value.scopeHash!==scopeHash||!value.threads||typeof value.threads!=='object'||Array.isArray(value.threads))throw new Error('Bridge checkpoint scope or version does not match this configuration.');
    for(const [id,cursor]of Object.entries(value.threads))if(!/^[0-9a-f-]{36}$/i.test(id)||!cursor||typeof cursor.identity!=='string'||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new Error('Bridge checkpoint contains an invalid source cursor.');
    for(const key of ['pushedEvents','pushedItems','polls','failures']as const)if(!Number.isSafeInteger(value[key])||value[key]<0)throw new Error('Bridge checkpoint contains invalid counters.');
    if(value.pending!==undefined) {
      if(!value.pending||typeof value.pending!=='object'||Array.isArray(value.pending))throw new Error('Bridge checkpoint contains invalid delivery intents.');
      for(const [id,intent]of Object.entries(value.pending))if(!value.threads[id]||intent.identity!==value.threads[id].identity||intent.from!==value.threads[id].offset||!Number.isSafeInteger(intent.to)||intent.to<=intent.from||typeof intent.deliveryId!=='string'||!/^[a-f0-9]{64}$/.test(intent.deliveryId)||!Number.isSafeInteger(intent.items)||intent.items<1||!Array.isArray(intent.itemIds)||intent.itemIds.length!==intent.items||intent.itemIds.some(i=>typeof i!=='string'||!i.startsWith(`${id}:`)))throw new Error('Bridge checkpoint contains an invalid delivery intent.');
      for(const intent of Object.values(value.pending))if(intent.batch) {
        if(typeof intent.batch.text!=='string'||intent.batch.text.length>CODEX_NOTIFICATION_TEXT_CHARS||!intent.batch.meta||typeof intent.batch.meta!=='object'||!Number.isSafeInteger(intent.batch.deferredAdded)||intent.batch.deferredAdded<0||!Number.isSafeInteger(intent.batch.suppressed)||intent.batch.suppressed<0)throw new Error('Bridge checkpoint contains an invalid notification batch.');
        validateDeferred(intent.batch.deferred);validateNotifications(intent.batch.notifications);
      }
    }
    if(value.deferred!==undefined) { record(value.deferred);for(const [id,groups]of Object.entries(value.deferred)) { if(!value.threads[id])throw new Error('Deferred thread has no source cursor.');validateDeferred(groups); } }
    if(value.notifications!==undefined) { record(value.notifications);for(const [id,state]of Object.entries(value.notifications)) { if(!value.threads[id])throw new Error('Notification thread has no source cursor.');validateNotifications(state); } }
    for(const key of ['deferredItems','suppressedTerminalItems']as const)if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]!<0))throw new Error('Bridge checkpoint contains invalid notification counters.');
    if(activeNotificationRoutes(value)>CODEX_ACTIVE_ROUTE_LIMIT)throw new Error(`Bridge checkpoint exceeds the ${CODEX_ACTIVE_ROUTE_LIMIT} active task route limit; preserve the file and recover it before restarting.`);
    if(typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt))||[value.lastPollAt,value.lastSuccessAt].some(t=>t!==null&&(typeof t!=='string'||!Number.isFinite(Date.parse(t))))||value.lastError!==null&&(!value.lastError||typeof value.lastError.message!=='string'||typeof value.lastError.at!=='string'||!Number.isFinite(Date.parse(value.lastError.at))))throw new Error('Bridge checkpoint contains invalid status fields.');
    return value;
  }
  save(state:BridgeCheckpoint):void {
    if(Object.values(state.pending??{}).some(intent=>intent.batch&&intent.batch.text.length>CODEX_NOTIFICATION_TEXT_CHARS))throw new Error(`Notification summary exceeds the ${CODEX_NOTIFICATION_TEXT_CHARS} character limit; source cursors were retained.`);
    if(activeNotificationRoutes(state)>CODEX_ACTIVE_ROUTE_LIMIT)throw new Error(`Codex active task routes exceed the ${CODEX_ACTIVE_ROUTE_LIMIT} limit; source cursors and deferred progress were retained.`);
    state.updatedAt=this.clock();
    const temp=`${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    renameSync(temp,this.file);
  }
  record(kind:string,data:Record<string,unknown>={}):void {
    const ts=this.clock();
    appendFileSync(join(this.dir,`audit-${ts.slice(0,10)}.jsonl`),JSON.stringify({ts,source:'codexbridge',kind,...data})+'\n','utf8');
  }
}

/** Include durable pending batches: their future routes also reserve capacity. */
export function activeNotificationRoutes(state:Pick<BridgeCheckpoint,'deferred'|'notifications'|'pending'>):number {
  const threadIds=new Set([...Object.keys(state.deferred??{}),...Object.keys(state.notifications??{}),...Object.keys(state.pending??{})]);
  let total=0;
  for(const id of threadIds) {
    const keys=new Set<string>();
    const batches=[{deferred:state.deferred?.[id],notifications:state.notifications?.[id]},state.pending?.[id]?.batch];
    for(const batch of batches)if(batch) {
      for(const key of Object.keys(batch.deferred??{}))keys.add(key);
      for(const [key,route]of Object.entries(batch.notifications?.routes??{}))if(!route.terminal)keys.add(key);
    }
    total+=keys.size;
  }
  return total;
}

function record(value:unknown):asserts value is Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Bridge checkpoint contains invalid notification metadata.');
}
function validateDeferred(groups:Record<string,DeferredProgress>):void {
  record(groups);
  for(const g of Object.values(groups)) {
    if(!g||typeof g.cwd!=='string'||!Number.isSafeInteger(g.from)||g.from<0||!Number.isSafeInteger(g.to)||g.to<=g.from||!Number.isSafeInteger(g.items)||g.items<1||typeof g.firstAt!=='string'||typeof g.lastAt!=='string'||g.turnId!==undefined&&typeof g.turnId!=='string')throw new Error('Bridge checkpoint contains invalid deferred progress.');
    record(g.counts);if(Object.values(g.counts).some(n=>!Number.isSafeInteger(n)||n<0)||Object.values(g.counts).reduce((n,v)=>n+v,0)!==g.items)throw new Error('Bridge checkpoint contains invalid progress counters.');
    if(g.lastProgress&&(typeof g.lastProgress.text!=='string'||g.lastProgress.text.length>2000||typeof g.lastProgress.id!=='string'||typeof g.lastProgress.ts!=='string'||typeof g.lastProgress.truncated!=='boolean'||!Number.isSafeInteger(g.lastProgress.offset)||!Number.isSafeInteger(g.lastProgress.endOffset)))throw new Error('Bridge checkpoint contains invalid last progress.');
  }
}
function validateNotifications(state:ThreadNotifications):void {
  record(state);if(!Number.isSafeInteger(state.anonymousEpoch)||state.anonymousEpoch<0)throw new Error('Bridge checkpoint contains invalid anonymous task identity.');
  record(state.routes);for(const r of Object.values(state.routes)) { if(!r||typeof r.terminal!=='boolean'||typeof r.lastAt!=='string'||r.finalHash!==undefined&&typeof r.finalHash!=='string'||r.completionSeen!==undefined&&typeof r.completionSeen!=='boolean')throw new Error('Bridge checkpoint contains invalid task notification receipt.');record(r.importantHashes);if(Object.values(r.importantHashes).some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))throw new Error('Bridge checkpoint contains invalid important fingerprints.'); }
}
