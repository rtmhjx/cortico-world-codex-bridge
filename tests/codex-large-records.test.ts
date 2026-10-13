import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import { CodexRolloutReader, CodexReaderError } from '../src/reader.ts';
import { CodexBridgeWorld } from '../src/world.ts';
import { codexBridgeDefaults } from '../src/config.ts';

const MiB=1024*1024,root=join(process.cwd(),'scratch','codex-large-record-tests');mkdirSync(root,{recursive:true});
const encode=(value:unknown)=>JSON.stringify(value)+'\n';
const message=(text:string,phase='final_answer')=>({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
function fixture() {
  const dir=mkdtempSync(join(root,'run-')),sessions=join(dir,'sessions'),allowed=join(dir,'workspace'),denied=join(allowed,'private'),data=join(dir,'data'),hostData=join(dir,'host');
  for(const p of [sessions,allowed,denied,data,hostData])mkdirSync(p);
  const id=randomUUID(),file=join(sessions,`rollout-${id}.jsonl`),meta={type:'session_meta',payload:{id,cwd:allowed,source:'vscode'}};
  writeFileSync(file,encode(meta));
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(encode).join(''));
  const context=(cwd=allowed,turn='turn-a')=>({type:'turn_context',payload:{cwd,turn_id:turn}});
  const reader=()=>new CodexRolloutReader({sessionsDir:sessions,allowedWorkspaces:[allowed],deniedWorkspaces:[denied],includeSubagents:false});
  function large(prefix:string,size:number,suffix:string|Buffer) {
    const fd=openSync(file,'a'),start=statSync(file).size,chunk=Buffer.alloc(Math.min(size,MiB),120);
    try { writeSync(fd,Buffer.from(prefix));for(let remaining=size;remaining>0;remaining-=chunk.length)writeSync(fd,chunk.subarray(0,Math.min(remaining,chunk.length)));writeSync(fd,Buffer.isBuffer(suffix)?suffix:Buffer.from(suffix)); }
    finally {closeSync(fd)}return {start,end:statSync(file).size};
  }
  const cfg={...codexBridgeDefaults(),enabled:true,sessionsDir:sessions,allowedWorkspaces:JSON.stringify([allowed]),deniedWorkspaces:JSON.stringify([denied]),watchIntervalSeconds:0};
  let store=new JsonlEventStore({dataDir:hostData,run:'r-20261008-190000-abcd'}),failPush=false;const triggers:string[]=[],deliveryModes=new Map<number,boolean>();
  const host=()=>({store,pushEvent:async(e:Omit<EventEnvelope,'cursor'>,opts?:{trigger?:string;deliver?:boolean})=>{if(failPush)throw new Error('injected push failure');const saved=store.append(e);deliveryModes.set(saved.cursor,opts?.deliver!==false);if(opts?.deliver!==false)triggers.push(opts?.trigger??'default');return saved;}} as unknown as WorldHost);
  return {dir,sessions,allowed,denied,id,file,meta,data,cfg,append,context,reader,large,host,triggers,
    reloadHost:()=>{store=new JsonlEventStore({dataDir:hostData,run:'r-20261008-190000-abcd'});return host();},
    events:()=>store.range({source:'codexbridge',limit:10000}).filter(e=>deliveryModes.get(e.cursor)!==false),
    archived:()=>store.range({source:'codexbridge',limit:10000}).filter(e=>deliveryModes.get(e.cursor)===false),setFailPush:(value:boolean)=>{failPush=value;},
    checkpoint:()=>JSON.parse(readFileSync(join(data,'codexbridge','checkpoint.json'),'utf8')),
    world:()=>new CodexBridgeWorld({cfg,dataDir:data})};
}
const error=(code:string)=>(e:unknown)=>e instanceof CodexReaderError&&e.code===code;

test('2.42 MiB ignored image completion finishes atomically past 2 MiB and leaves final for the next page',()=>{
  const f=fixture();f.append(f.context());const line=f.large('{"payload":{"item":{"result":"',2532264,'","type":"Extension","kind":"image_gen.generation"},"type":"item_completed"},"type":"event_msg"}\n');f.append(message('final after image'));
  const r=f.reader(),page=r.readPage(f.id,{offset:line.start,maxBytes:2*MiB});assert.equal(page.items.length,0);assert.equal(page.nextOffset,line.end);assert.equal(page.bytesScanned,line.end-line.start);
  assert.equal(page.budgetExceeded,true);assert.equal(page.budgetOverrunBytes,page.bytesScanned-2*MiB);assert.equal(page.contextBytesScanned,line.start);
  const final=r.readPage(f.id,{offset:page.nextOffset});assert.equal(final.items[0].text,'final after image');assert.equal(final.items[0].turnId,'turn-a');
});
test('late message type/role/phase survive a 40 MiB non-text image without retaining it',()=>{
  const f=fixture();f.append(f.context());const line=f.large('{"payload":{"content":[{"type":"image","image_url":{"url":"',40*MiB,'"}},{"type":"output_text","text":"public final"}],"phase":"final_answer","role":"assistant","type":"message"},"type":"response_item"}\n');
  const page=f.reader().readPage(f.id,{offset:line.start,maxBytes:4096,maxChars:100});assert.equal(page.items[0].text,'public final');assert.equal(page.items[0].phase,'final_answer');assert.equal(page.nextOffset,line.end);assert.ok(page.bytesScanned>40*MiB);assert.equal(page.budgetExceeded,true);
  assert.ok(JSON.stringify(page).length<2000);
});
test('nested output and arguments preserve important fields after huge discarded strings',()=>{
  const f=fixture();f.append(f.context());
  const output=f.large('{"payload":{"output":"{\\"image\\":\\"',9*MiB,'\\",\\"error\\":{\\"message\\":\\"limit reached\\",\\"code\\":\\"rate_limit_exceeded\\"}}","type":"function_call_output"},"type":"response_item"}\n');
  const args=f.large('{"payload":{"arguments":"{\\"irrelevant\\":\\"',9*MiB,'\\",\\"questions\\":[{\\"question\\":\\"Choose now\\",\\"options\\":[{\\"label\\":\\"A\\",\\"description\\":\\"public choice\\"}]}]}","name":"functions.request_user_input","type":"function_call"},"type":"response_item"}\n');
  const r=f.reader(),a=r.readPage(f.id,{offset:output.start,maxBytes:4096}),b=r.readPage(f.id,{offset:args.start,maxBytes:4096});
  assert.equal(a.items[0].importantReason,'rate_limit');assert.equal(a.items[0].offset,output.start);assert.equal(a.items[0].endOffset,output.end);assert.equal(a.items[0].text,'Codex 结构化信号：rate_limit');assert.equal(b.items[0].importantReason,'request_user_input');assert.match(b.items[0].text!,/Choose now/);assert.match(b.items[0].text!,/选项：A/);
});
test('context replay crosses old large records and duplicate cwd keys retain last-value denial',()=>{
  const f=fixture();f.append(f.context());f.large('{"type":"event_msg","payload":{"type":"item_completed","item":{"result":"',10*MiB,'"}}}\n');
  appendFileSync(f.file,`{"type":"turn_context","payload":{"cwd":${JSON.stringify(f.allowed)},"cwd":${JSON.stringify(f.denied)},"turn_id":"private"}}\n`);const privateOffset=statSync(f.file).size;f.append(message('must stay private'),f.context(f.allowed,'public'));const publicOffset=statSync(f.file).size;f.append(message('public final'));
  const r=f.reader(),page=r.readPage(f.id,{offset:privateOffset}),publicPage=r.readPage(f.id,{offset:publicOffset});
  assert.deepEqual(page.items.map(i=>i.text),['public final']);assert.equal(publicPage.items[0].turnId,'public');assert.equal(publicPage.contextBytesScanned,publicOffset);assert.ok(publicPage.contextBytesScanned>10*MiB);
  appendFileSync(f.file,`{"type":"turn_context","payload":{"cwd":${JSON.stringify(f.allowed+'x'.repeat(32769))}}}\n`);assert.throws(()=>r.readPage(f.id,{offset:publicOffset}),error('PROJECTION_LIMIT'));
});
test('ignored fields still validate bad escape, invalid number, missing bracket and invalid UTF8',()=>{
  for(const suffix of ['\\q"}}}\n','","number":01}}}\n','"}}\n',Buffer.concat([Buffer.from([0xc0,0xaf]),Buffer.from('"}}}\n')])]) {
    const f=fixture(),line=f.large('{"type":"event_msg","payload":{"item":{"result":"',3*MiB,suffix);
    assert.throws(()=>f.reader().readPage(f.id,{offset:line.start,maxBytes:4096}),error('MALFORMED_LINE'));
  }
});
test('large torn tail is not consumed and streams successfully when its closing LF arrives',()=>{
  const f=fixture(),line=f.large('{"type":"event_msg","payload":{"item":{"result":"',9*MiB,'"},"type":"item_completed"}}');
  const r=f.reader(),tail=r.readPage(f.id,{offset:line.start,maxBytes:4096});assert.equal(tail.nextOffset,line.start);assert.equal(tail.tornTail,true);assert.equal(tail.bytesScanned,0);
  appendFileSync(f.file,'\n');f.append(message('after torn tail'));const complete=r.readPage(f.id,{offset:line.start,maxBytes:4096});assert.ok(complete.bytesScanned>9*MiB);assert.equal(complete.items.length,0);
  assert.equal(r.readPage(f.id,{offset:complete.nextOffset}).items[0].text,'after torn tail');
});
test('discarded strings validate UTF8 across chunk boundaries and reject BOM; source identity stays compatible',()=>{
  const f=fixture(),prefix='{"type":"event_msg","payload":{"item":{"result":"';
  const padding=65536-Buffer.byteLength(prefix)-1,line=f.large(prefix,padding,'🙂"},"type":"item_completed"}}\n');
  const r=f.reader(),info=r.discover()[0],stat=statSync(f.file),first=Buffer.from(encode(f.meta).slice(0,-1));
  assert.equal(info.identity,createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:`).update(first).digest('hex'));assert.equal(r.readPage(f.id,{offset:line.start,maxBytes:4096}).nextOffset,line.end);
  const bad=f.large('',0,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(encode(message('BOM rejected')))]));assert.throws(()=>r.readPage(f.id,{offset:bad.start}),error('MALFORMED_LINE'));
});
test('clipped environment wrappers stay filtered and clipped quoted credentials never expose their prefix',()=>{
  const f=fixture();f.append({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>'+'private injected body'.repeat(10000)+'</environment_context>'}]}});
  let r=f.reader(),page=r.readPage(f.id,{maxChars:80});assert.equal(page.items.length,0);assert.equal(page.nextOffset,statSync(f.file).size);
  const start=statSync(f.file).size;f.append(message('{"api_key":"private-credential-'+ 's'.repeat(10000)+'"}'));r=f.reader();page=r.readPage(f.id,{offset:start,maxChars:60});assert.equal(page.items[0].text!.includes('private-credential'),false);assert.match(page.items[0].text!,/REDACTED/);assert.equal(page.items[0].truncated,true);
});
test('many tiny multimodal blocks remain bounded and retain final boundary with explicit truncation',()=>{
  const f=fixture();f.append({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:Array.from({length:20000},()=>({type:'image',image_url:{url:'opaque'}}))}});
  const page=f.reader().readPage(f.id,{maxChars:100});assert.equal(page.items[0].phase,'final_answer');assert.equal(page.items[0].truncated,true);assert.ok(JSON.stringify(page).length<2000);
});
test('late scalar error truthiness and quota enum retain independent structural budgets',()=>{
  for(const [type,key,value,state,reason]of [['task_complete','error','failure after oversized message','failed',undefined],['error','codex_error_info','UsageLimitExceeded',undefined,'quota'],['task_complete','codex_error_info','UsageLimitExceeded','completed',undefined]] as const) {
    const f=fixture();f.append(f.context());const line=f.large('{"type":"event_msg","payload":{"message":"',3*MiB,`","${key}":${JSON.stringify(value)},"type":${JSON.stringify(type)}}}\n`);
    const item=f.reader().readPage(f.id,{offset:line.start,maxBytes:4096,maxChars:16}).items[0];assert.equal(item.state,state);assert.equal(item.importantReason,reason);
  }
});
test('original content/kind counts cannot become falsely equal when projection caps both arrays',()=>{
  for(const [contentCount,kindsCount]of [[257,256],[256,257]]) {
    const f=fixture();f.append({type:'response_item',payload:{type:'message',role:'user',content:Array.from({length:contentCount},()=>({type:'input_text',text:'must not be exported'})),internal_chat_message_metadata_passthrough:{content_item_kinds:Array.from({length:kindsCount},()=> 'user.text')}}});
    assert.equal(f.reader().readPage(f.id,{maxChars:100}).items.length,0);
  }
});
test('credentials split across text blocks remain redacted when the joined public message is clipped',()=>{
  const f=fixture(),first='token="synthetic-secret-prefix';f.append({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:first},{type:'output_text',text:'secret-ending"'}]}});
  const page=f.reader().readPage(f.id,{maxChars:first.length+2});assert.equal(page.items[0].text!.includes('synthetic-secret'),false);assert.match(page.items[0].text!,/REDACTED/);assert.equal(page.items[0].truncated,true);
});
test('clipped known JWT and sk credential prefixes retain the original full-text redaction boundary',()=>{
  for(const [text,maxChars]of [['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.syntheticSignature1234',35],['sk-TESTONLY0123456789TESTONLY0123456789',11]] as const) {
    const f=fixture();f.append(message(text));const page=f.reader().readPage(f.id,{maxChars});assert.equal(page.items[0].text!.startsWith('eyJ'),false);assert.equal(page.items[0].text!.includes('sk-proj-'),false);assert.match(page.items[0].text!,/REDACTED/);assert.equal(page.items[0].truncated,true);
  }
});
test('nested structured strings decode once and scalar/array tool values validate without becoming signals',()=>{
  const f=fixture();f.append(
    {type:'response_item',payload:{type:'function_call_output',output:JSON.stringify(JSON.stringify({error:{code:'quota_exceeded'}}))}},
    {type:'response_item',payload:{type:'function_call',name:'functions.exec_command',arguments:JSON.stringify(JSON.stringify({sandbox_permissions:'require_escalated'}))}},
    {type:'response_item',payload:{type:'function_call_output',output:'1'.repeat(256)}},
    {type:'response_item',payload:{type:'function_call_output',output:[{error:{code:'quota_exceeded'}}]}});
  appendFileSync(f.file,'{"type":"response_item","payload":{"type":"function_call_output","output":'+ '1'.repeat(256)+'}}\n');
  appendFileSync(f.file,'{"type":"response_item","payload":{"type":"function_call_output","output":{"error":{"code":"quota_exceeded"}},"output":123}}\n');
  const page=f.reader().readPage(f.id);assert.equal(page.items.length,0);assert.equal(page.nextOffset,statSync(f.file).size);
});
test('ordinary large image progress never notifies; final flushes once and completion duplicate remains suppressed',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host());f.append(f.context(),message('ordinary progress','commentary'));await w.pollOnce();assert.equal(f.events().length,0);assert.equal(f.archived().length,1);assert.equal(f.archived()[0].meta?.warehouseProgressOnly,true);assert.deepEqual(f.triggers,[]);
  f.large('{"type":"event_msg","payload":{"type":"item_completed","item":{"result":"',10*MiB,'"}}}\n');f.append(message('final done'),{type:'event_msg',payload:{type:'task_complete',turn_id:'turn-a'}});
  await w.pollOnce();assert.equal(f.events().length,0);await w.pollOnce();assert.equal(f.events().length,1);assert.match(f.events()[0].text,/ordinary progress/);assert.match(f.events()[0].text,/final done/);await w.pollOnce();assert.equal(f.events().length,1);assert.deepEqual(f.triggers,['flush']);await w.stop();
});
test('40 MiB important record survives failed push restart and a saved host receipt cannot duplicate wake',async()=>{
  for(const policy of ['important','all'] as const) {
    const f=fixture();f.cfg.notificationPolicy=policy;const a=f.world();await a.start(f.host());f.append(f.context());await a.pollOnce();
    f.large('{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"large final ',40*MiB,'"}]}}\n');f.setFailPush(true);await a.pollOnce();assert.ok(f.checkpoint().pending[f.id]);const saved=f.checkpoint().pending[f.id];assert.ok(saved.to-saved.from>32*MiB);await a.stop();
    f.setFailPush(false);const b=f.world();await b.start(f.reloadHost());const runtime=(b as unknown as {runtime:{save:(s:unknown)=>void}}).runtime,save=runtime.save.bind(runtime);
    runtime.save=(s)=>{if(f.events().length)throw new Error('injected post-host checkpoint failure');save(s);};await b.pollOnce();assert.equal(f.events().length,1);await b.stop();
    f.append(message('later result'));const c=f.world();await c.start(f.reloadHost());await c.pollOnce();assert.equal(f.events().length,1);assert.equal(f.checkpoint().pushedEvents,1);await c.pollOnce();assert.equal(f.events().length,2);assert.match(f.events()[1].text,/later result/);await c.stop();
  }
});
test('48 MiB ignored image streams in a process with only 64 MiB of old-space heap',()=>{
  const f=fixture();const line=f.large('{"type":"event_msg","payload":{"item":{"result":"',48*MiB,'"},"type":"item_completed"}}\n');
  const module=pathToFileURL(join(process.cwd(),'src/reader.ts')).href;
  const code=`import {CodexRolloutReader} from ${JSON.stringify(module)};const r=new CodexRolloutReader(${JSON.stringify({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false})});const p=r.readPage(${JSON.stringify(f.id)},{offset:${line.start},maxBytes:4096,maxChars:100});if(p.nextOffset!==${line.end}||p.items.length)throw new Error('Streaming projection mismatch');console.log(JSON.stringify({bytesScanned:p.bytesScanned,budgetExceeded:p.budgetExceeded}));`;
  const run=spawnSync(process.execPath,['--max-old-space-size=64','--import','tsx','--input-type=module','-e',code],{encoding:'utf8',timeout:90000});
  assert.equal(run.status,0,run.stderr||String(run.error));assert.ok(JSON.parse(run.stdout.trim()).bytesScanned>48*MiB);
});
