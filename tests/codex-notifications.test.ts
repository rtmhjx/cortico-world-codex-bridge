import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import { CodexBridgeWorld } from '../src/world.ts';
import { CodexRolloutReader } from '../src/reader.ts';
import { CODEX_ACTIVE_ROUTE_LIMIT, CODEX_NOTIFICATION_TEXT_CHARS } from '../src/runtime.ts';
import { codexBridgeDefaults } from '../src/config.ts';

const root=join(process.cwd(),'scratch','codex-notification-tests');mkdirSync(root,{recursive:true});
const encode=(row:unknown)=>JSON.stringify(row)+'\n';
const ts='2026-10-07T08:00:00Z';
const msg=(text:string,phase='commentary')=>({type:'response_item',timestamp:ts,payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
const lifecycle=(type:string,turnId?:string)=>({type:'event_msg',timestamp:ts,payload:{type,...(turnId?{turn_id:turnId}:{})}});
const question=(text:string)=>({type:'response_item',timestamp:ts,payload:{type:'function_call',name:'functions.request_user_input',arguments:JSON.stringify({questions:[{question:text}]})}});
function fixture() {
  const dir=mkdtempSync(join(root,'run-')),sessions=join(dir,'sessions'),workspace=join(dir,'workspace'),data=join(dir,'data'),hostData=join(dir,'host');
  for(const p of [sessions,workspace,data,hostData])mkdirSync(p);
  const id=randomUUID(),file=join(sessions,`rollout-${id}.jsonl`);
  const meta=(threadId:string)=>({type:'session_meta',timestamp:ts,payload:{id:threadId,cwd:workspace,source:'vscode'}});
  writeFileSync(file,encode(meta(id)));
  const cfg={...codexBridgeDefaults(),enabled:true,sessionsDir:sessions,allowedWorkspaces:JSON.stringify([workspace]),watchIntervalSeconds:0};
  const triggers:string[]=[],deliveryModes=new Map<number,boolean>();let failPush=false;
  let store=new JsonlEventStore({dataDir:hostData,run:'2026-10-07T08-00-00-test'});
  const makeHost=()=>({store,pushEvent:async(e:Omit<EventEnvelope,'cursor'>,opts?:{trigger?:string;deliver?:boolean})=>{
    if(failPush)throw new Error('injected host write failure');
    const saved=store.append(e);deliveryModes.set(saved.cursor,opts?.deliver!==false);
    if(opts?.deliver!==false)triggers.push(opts?.trigger??'default');return saved;
  }} as unknown as WorldHost);
  const world=()=>new CodexBridgeWorld({cfg,dataDir:data});
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(encode).join(''));
  const context=(turnId:string)=>({type:'turn_context',payload:{cwd:workspace,turn_id:turnId}});
  const checkpoint=()=>JSON.parse(readFileSync(join(data,'codexbridge','checkpoint.json'),'utf8'));
  return {dir,sessions,workspace,data,id,file,cfg,world,append,context,checkpoint,triggers,meta,
    host:makeHost,events:()=>store.range({source:'codexbridge',limit:10000}).filter(e=>deliveryModes.get(e.cursor)!==false),
    archived:()=>store.range({source:'codexbridge',limit:10000}).filter(e=>deliveryModes.get(e.cursor)===false),setFailPush:(v:boolean)=>{failPush=v;},
    reloadHost:()=>{store=new JsonlEventStore({dataDir:hostData,run:'2026-10-07T08-00-00-test'});return makeHost();}};
}

test('many five-second ordinary polls archive with deliver:false without model wake, then final flushes once',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('turn-a'),lifecycle('task_started','turn-a'));
  for(let i=0;i<8;i++) { f.append(msg(`progress-${i}`));await w.pollOnce(); }
  assert.equal(f.events().length,0);assert.equal(f.archived().length,9);assert.ok(f.archived().every(e=>e.meta?.warehouseProgressOnly===true));assert.deepEqual(f.triggers,[]);
  assert.equal(w.status().deferredItems,9);assert.equal(f.checkpoint().threads[f.id].offset,statSync(f.file).size);
  f.append(msg('done','final_answer'),lifecycle('task_complete','turn-a'));await w.pollOnce();
  assert.equal(f.events().length,1);assert.deepEqual(f.triggers,['flush']);assert.match(f.events()[0].text,/progress-7/);assert.doesNotMatch(f.events()[0].text,/progress-0/);
  assert.equal(f.events()[0].meta?.ordinaryItems,9);assert.equal(f.events()[0].meta?.importantItems,2);assert.equal(w.status().deferredItems,0);
  await w.pollOnce();assert.equal(f.events().length,1);assert.equal(f.archived().length,9);await w.stop();
});
test('separate source threads never flush one another’s ongoing work',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('turn-a'),msg('thread A progress'));await w.pollOnce();
  const other=randomUUID();writeFileSync(join(f.sessions,`rollout-${other}.jsonl`),[f.meta(other),f.context('turn-b'),msg('thread B progress'),msg('thread B done','final_answer')].map(encode).join(''));
  await w.pollOnce();assert.equal(f.events().length,1);assert.equal(f.events()[0].meta?.threadId,other);assert.doesNotMatch(f.events()[0].text,/thread A progress/);assert.equal(w.status().deferredItems,1);
  f.append(msg('thread A done','final_answer'));await w.pollOnce();assert.equal(f.events().length,2);assert.match(f.events()[1].text,/thread A progress/);await w.stop();
});
test('same thread different turn routes flush only their own accumulated progress',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('a'),msg('A stays pending'),f.context('b'),msg('B progress'));await w.pollOnce();
  f.append(msg('B completes','final_answer'));await w.pollOnce();assert.equal(f.events().length,1);assert.doesNotMatch(f.events()[0].text,/A stays pending/);assert.equal(w.status().deferredItems,1);
  f.append(f.context('a'),msg('A completes','final_answer'));await w.pollOnce();assert.equal(f.events().length,2);assert.match(f.events()[1].text,/A stays pending/);await w.stop();
});
test('explicit questions, approval, waiting user and quota errors flush; question marks and ordinary tools do not',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('turn-a'),msg('Does this code compile?'),
    {type:'response_item',payload:{type:'function_call',name:'functions.exec_command',arguments:'{"cmd":"echo ordinary"}'}},
    {type:'response_item',payload:{type:'reasoning',summary:'hidden quota secret'}},msg('We discuss quota, rate_limit and credits here'));
  await w.pollOnce();assert.equal(f.events().length,0);
  f.append(question('Choose the intended output'));await w.pollOnce();assert.equal(f.events().length,1);assert.match(f.events()[0].text,/Choose the intended output/);assert.doesNotMatch(f.events()[0].text,/hidden quota secret/);
  f.append({type:'response_item',timestamp:ts,payload:{type:'function_call',name:'functions.exec_command',arguments:JSON.stringify({sandbox_permissions:'require_escalated',justification:'Approve this operation'})}});await w.pollOnce();
  assert.deepEqual(f.events()[1].meta?.importantReasons,['approval_required']);
  f.append({type:'event_msg',timestamp:ts,payload:{type:'waiting_for_user'}});await w.pollOnce();assert.deepEqual(f.events()[2].meta?.importantReasons,['waiting_user']);
  for(const [code,reason]of [['insufficient_quota','quota'],['rate_limit_exceeded','rate_limit'],['insufficient_credits','credits']]) {
    f.append({type:'event_msg',timestamp:ts,payload:{type:'error',error:{code}}});await w.pollOnce();assert.deepEqual(f.events().at(-1)!.meta?.importantReasons,[reason]);
  }
  assert.equal(f.events().length,6);await w.stop();
});
test('ordinary accumulation survives restart and stores only scrubbed, bounded latest progress',async()=>{
  const f=fixture();f.cfg.eventContentChars=80;const a=f.world();await a.start(f.host());f.append(f.context('turn-a'),msg('api_key="private-secret-123" '+ 'x'.repeat(160)));await a.pollOnce();
  const g=Object.values(f.checkpoint().deferred[f.id])[0] as {lastProgress:{text:string;truncated:boolean}};
  assert.equal(g.lastProgress.text.includes('private-secret'),false);assert.ok(g.lastProgress.text.length<=80);assert.equal(g.lastProgress.truncated,true);await a.stop();
  const b=f.world();await b.start(f.reloadHost());f.append(msg('done after restart','final_answer'));await b.pollOnce();assert.equal(f.events().length,1);assert.equal(f.events()[0].meta?.ordinaryItems,1);assert.equal(b.status().deferredItems,0);await b.stop();
});
test('failed host push keeps saved summary plus accumulation and retries fixed batch first',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('turn-a'),msg('kept progress'));await w.pollOnce();const before=f.checkpoint().threads[f.id].offset;
  f.append(question('first question'));f.setFailPush(true);await w.pollOnce();assert.ok(f.checkpoint().pending[f.id].batch);assert.equal(f.checkpoint().threads[f.id].offset,before);assert.equal(w.status().deferredItems,1);
  f.append(question('second question'));f.setFailPush(false);await w.pollOnce();assert.equal(f.events().length,1);assert.doesNotMatch(f.events()[0].text,/second question/);assert.equal(f.events()[0].meta?.ordinaryItems,1);
  await w.pollOnce();assert.equal(f.events().length,2);assert.match(f.events()[1].text,/second question/);await w.stop();
});
test('host append followed by failed checkpoint resumes from real durable store without duplicate wake',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host());f.append(f.context('turn-a'),msg('saved progress'));await a.pollOnce();f.append(msg('durable final','final_answer'));
  const runtime=(a as unknown as {runtime:{save:(s:unknown)=>void}}).runtime,save=runtime.save.bind(runtime);
  runtime.save=(s)=>{if(f.events().length)throw new Error('injected disk failure after host append');save(s);};await a.pollOnce();assert.equal(f.events().length,1);assert.ok(f.checkpoint().pending[f.id]);await a.stop();
  f.append(lifecycle('task_complete','turn-a'));const b=f.world();await b.start(f.reloadHost());await b.pollOnce();assert.equal(f.events().length,1);assert.equal(f.checkpoint().pushedEvents,1);assert.equal(b.status().deferredItems,0);
  await b.pollOnce();assert.equal(f.events().length,1);assert.deepEqual(f.triggers,['flush']);
  assert.equal(f.archived().filter(e=>e.meta?.warehouseProgressOnly).length,1);assert.equal(f.archived().filter(e=>e.meta?.warehouseLifecycleOnly).length,1);await b.stop();
});
test('same turn terminal pair across page boundaries is suppressed, new final content still wakes',async()=>{
  const f=fixture();f.cfg.watchMaxItems=1;const w=f.world();await w.start(f.host());f.append(f.context('turn-a'),msg('progress'),msg('final','final_answer'),lifecycle('task_complete','turn-a'));
  await w.pollOnce();assert.equal(f.events().length,0);await w.pollOnce();assert.equal(f.events().length,1);await w.pollOnce();assert.equal(f.events().length,1);
  f.append(msg('final','final_answer'),lifecycle('task_complete','turn-a'));await w.pollOnce();await w.pollOnce();assert.equal(f.events().length,1);
  f.append(msg('new important clarification','final_answer'));await w.pollOnce();assert.equal(f.events().length,2);assert.ok((w.status().suppressedTerminalItems as number)>=2);
  assert.equal(f.archived().filter(e=>e.meta?.warehouseLifecycleOnly).length,1);await w.stop();
});
test('anonymous turn pairing does not swallow later independent task terminals',async()=>{
  const f=fixture();f.cfg.watchMaxItems=1;const w=f.world();await w.start(f.host());f.append(msg('anonymous final','final_answer'),lifecycle('task_complete'));
  await w.pollOnce();await w.pollOnce();assert.equal(f.events().length,1);
  f.append(lifecycle('task_complete'));await w.pollOnce();assert.equal(f.events().length,2);
  f.append(msg('same text may belong to a later task','final_answer'),lifecycle('task_complete'));await w.pollOnce();await w.pollOnce();assert.equal(f.events().length,3);
  f.append(msg('same text may belong to a later task','final_answer'));await w.pollOnce();assert.equal(f.events().length,4);await w.stop();
});
test('checkpoint v1 upgrade preserves cursor and counters; configured filters retain their scope',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host());await a.stop();const state=f.checkpoint();state.pushedEvents=7;state.pushedItems=9;
  delete state.notifications;delete state.deferred;writeFileSync(join(f.data,'codexbridge','checkpoint.json'),JSON.stringify(state));
  f.cfg.notifyPhases='final_answer';f.cfg.notifyUserMessages=false;f.cfg.notifyLifecycle=false;
  const b=f.world();await b.start(f.reloadHost());f.append(f.context('turn-a'),msg('excluded progress'),lifecycle('task_started','turn-a'),lifecycle('task_complete','turn-a'));
  await b.pollOnce();assert.equal(f.events().length,0);assert.equal(b.status().deferredItems,0);assert.equal(f.checkpoint().pushedEvents,7);
  f.append(question('structured signal still visible'));await b.pollOnce();assert.equal(f.events().length,1);assert.equal(f.checkpoint().pushedEvents,8);await b.stop();
});
test('reader exports only explicitly structured important signals and preserves public source positions',()=>{
  const f=fixture();f.append(f.context('turn-a'),question('Which option?'),
    {type:'response_item',timestamp:ts,payload:{type:'function_call_output',output:JSON.stringify({error:{code:'rate_limit_exceeded'},hidden:'do-not-export'})}},
    {type:'response_item',payload:{type:'custom_tool_call_output',output:'not a structured error; secret output'}},
    {type:'response_item',payload:{type:'message',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'hidden analysis question?'}]}});
  const r=new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.workspace],deniedWorkspaces:[],includeSubagents:false});
  const page=r.readPage(f.id);assert.deepEqual(page.items.map(i=>i.importantReason),['request_user_input','rate_limit']);assert.ok(page.items.every(i=>i.turnId==='turn-a'&&i.id===`${f.id}:${i.offset}`));
  assert.equal(JSON.stringify(page).includes('do-not-export'),false);assert.equal(JSON.stringify(page).includes('secret output'),false);assert.equal(JSON.stringify(page).includes('hidden analysis'),false);
});
test('failed and aborted states flush accumulated facts immediately; user and started remain ordinary',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());
  const user={type:'response_item',timestamp:ts,payload:{type:'message',role:'user',content:[{type:'input_text',text:'please continue'}]}};
  f.append(f.context('a'),lifecycle('task_started','a'),user,msg('a progress'));await w.pollOnce();assert.equal(f.events().length,0);assert.equal(w.status().deferredItems,3);
  f.append(lifecycle('task_failed','a'));await w.pollOnce();assert.deepEqual(f.events()[0].meta?.importantReasons,['failed']);assert.equal(f.events()[0].meta?.ordinaryItems,3);
  f.append(f.context('b'),msg('b progress'),lifecycle('turn_aborted','b'));await w.pollOnce();assert.deepEqual(f.events()[1].meta?.importantReasons,['aborted']);assert.equal(w.status().deferredItems,0);await w.stop();
});
test('two important boundaries in one page consume ordinary work between them',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('a'),msg('before first question'),question('first question'),msg('after first question'),question('second question'));
  await w.pollOnce();assert.equal(f.events().length,1);assert.equal(f.events()[0].meta?.ordinaryItems,2);assert.equal(f.events()[0].meta?.importantItems,2);assert.match(f.events()[0].text,/after first question/);assert.equal(w.status().deferredItems,0);await w.stop();
});
test('explicit all compatibility policy keeps immediate ordinary progress notification',async()=>{
  const f=fixture();f.cfg.notificationPolicy='all';const w=f.world();await w.start(f.host());f.append(f.context('a'),msg('ordinary progress still immediate'));
  await w.pollOnce();assert.equal(f.events().length,1);assert.match(f.events()[0].text,/ordinary progress still immediate/);assert.deepEqual(f.triggers,['debounce']);assert.equal(w.status().deferredItems,0);await w.stop();
});
test('a question with changed public choices is new important content; nested quota enum is explicit',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context('a'));
  const choices=(label:string)=>({type:'response_item',timestamp:ts,payload:{type:'function_call',name:'functions.request_user_input_async',arguments:JSON.stringify({questions:[{question:'Choose one',options:[{label,description:'public choice'}]}]})}});
  f.append(choices('A'));await w.pollOnce();assert.equal(f.events().length,1);
  f.append(choices('A'));await w.pollOnce();assert.equal(f.events().length,1);
  f.append(choices('B'));await w.pollOnce();assert.equal(f.events().length,2);assert.match(f.events()[1].text,/选项：B/);
  f.append({type:'event_msg',timestamp:ts,payload:{type:'error',codex_error_info:{UsageLimitExceeded:{}}}});await w.pollOnce();assert.deepEqual(f.events().at(-1)!.meta?.importantReasons,['quota']);await w.stop();
});
test('maximum 100-item 2000-character configuration creates a bounded pending summary loadable after failed push',async()=>{
  const f=fixture();f.cfg.watchMaxItems=100;f.cfg.eventContentChars=2000;const a=f.world();await a.start(f.host());
  const turns=Array.from({length:100},()=>randomUUID());
  f.append(...turns.flatMap((turn,i)=>[f.context(turn),msg(`progress-${i} `+'p'.repeat(2000))]));await a.pollOnce();assert.equal(a.status().deferredItems,100);assert.equal(f.events().length,0);
  const before=f.checkpoint().threads[f.id].offset;
  f.append(...turns.flatMap((turn,i)=>[f.context(turn),msg(`final-${i} `+'f'.repeat(2000),'final_answer')]));f.setFailPush(true);await a.pollOnce();
  const intent=f.checkpoint().pending[f.id];assert.ok(intent.batch.text.length<=CODEX_NOTIFICATION_TEXT_CHARS);assert.equal(intent.batch.meta.importantItems,100);assert.equal(intent.batch.meta.ordinaryItems,100);
  assert.equal(intent.batch.meta.routes.length,100);assert.equal(intent.batch.meta.itemSources.length,100);assert.equal(intent.batch.meta.summaryTruncated,true);assert.equal(intent.batch.meta.summaryExcerptedRoutes,100);
  assert.ok(intent.batch.meta.itemSources.every((s:{reason:string;fromOffset:number;toOffset:number})=>s.reason==='final_answer'&&s.toOffset>s.fromOffset));
  assert.match(intent.batch.text,/节选/);assert.match(intent.batch.text,/完整重要状态/);assert.equal(f.checkpoint().threads[f.id].offset,before);await a.stop();
  f.setFailPush(false);const b=f.world();await b.start(f.reloadHost());await b.pollOnce();assert.equal(f.events().length,1);assert.ok(f.events()[0].text.length<=CODEX_NOTIFICATION_TEXT_CHARS);
  assert.equal(f.events()[0].meta?.importantItems,100);assert.equal(b.status().deferredItems,0);assert.equal(b.status().activeRoutes,0);await b.stop();
});
test('global active route capacity fails explicitly without advancing source or dropping accumulated progress',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host());f.append(f.context('existing'),msg('preserve this accumulated work'));await a.pollOnce();await a.stop();
  const state=f.checkpoint();for(let i=1;i<CODEX_ACTIVE_ROUTE_LIMIT;i++)state.notifications[f.id].routes[`turn:active-${i}`]={terminal:false,lastAt:ts,importantHashes:{}};
  writeFileSync(join(f.data,'codexbridge','checkpoint.json'),JSON.stringify(state));const before=state.threads[f.id].offset;
  const b=f.world();await b.start(f.reloadHost());assert.equal(b.status().activeRoutes,CODEX_ACTIVE_ROUTE_LIMIT);
  f.append(f.context('over-capacity'),msg('must stay unread until capacity is available'));await b.pollOnce();
  assert.match(String(b.status().currentError),/10000.*limit/);assert.equal(f.checkpoint().threads[f.id].offset,before);assert.equal(b.status().activeRoutes,CODEX_ACTIVE_ROUTE_LIMIT);
  assert.equal(f.checkpoint().deferred[f.id]['turn:existing'].lastProgress.text,'preserve this accumulated work');assert.equal(f.checkpoint().notifications[f.id].routes['turn:over-capacity'],undefined);assert.equal(f.events().length,0);await b.stop();
});
