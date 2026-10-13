import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope, WorldHost, ToolCallContext } from 'cortico/core/types.ts';
import { CodexBridgeWorld } from '../src/world.ts';
import { codexBridgeDefaults } from '../src/config.ts';
import { CodexRolloutReader } from '../src/reader.ts';

const root=join(process.cwd(),'scratch','codex-world-tests');mkdirSync(root,{recursive:true});
const msg=(text:string,phase='final_answer')=>({type:'response_item',timestamp:'2026-10-05T00:00:01Z',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
const encode=(r:unknown)=>JSON.stringify(r)+'\n';
function fixture() {
  const dir=mkdtempSync(join(root,'run-')),sessions=join(dir,'sessions'),workspace=join(dir,'workspace'),data=join(dir,'data');
  mkdirSync(sessions);mkdirSync(workspace);mkdirSync(data);
  const id=randomUUID(),file=join(sessions,`rollout-${id}.jsonl`);
  const meta={type:'session_meta',payload:{id,cwd:workspace,source:'vscode'}};
  writeFileSync(file,encode(meta)+encode(msg('historical result')));
  const cfg={...codexBridgeDefaults(),enabled:true,sessionsDir:sessions,allowedWorkspaces:JSON.stringify([workspace]),watchIntervalSeconds:0};
  const events:EventEnvelope[]=[];
  let failPush=false;
  const host={store:{grep:(q:{source:string;keyword:string})=>events.filter(e=>e.source===q.source&&e.text.includes(q.keyword)).map(e=>({hitCursor:e.cursor,events:[e]}))},
    pushEvent:async(e:Omit<EventEnvelope,'cursor'>)=>{if(failPush)throw new Error('injected push failure');const saved={...e,cursor:events.length+1};events.push(saved);return saved;}} as unknown as WorldHost;
  const world=()=>new CodexBridgeWorld({cfg,dataDir:data});
  const append=(...rows:unknown[])=>appendFileSync(file,rows.map(encode).join(''));
  const checkpoint=()=>JSON.parse(readFileSync(join(data,'codexbridge','checkpoint.json'),'utf8'));
  const tool=async(w:CodexBridgeWorld,name:string,args:Record<string,unknown>)=>{
    const result=await w.tools().find(t=>t.name===`codexbridge_${name}`)!.handler(args,{} as ToolCallContext);
    assert.equal(typeof result,'string',JSON.stringify(result));return JSON.parse(result as string);
  };
  return {dir,sessions,workspace,data,id,file,cfg,events,host,world,append,checkpoint,tool,setFailPush:(v:boolean)=>{failPush=v;}};
}

test('first boot baselines history; public progress/results with equal timestamps deliver once',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);await w.pollOnce();assert.equal(f.events.length,0);
  f.append(msg('progress','commentary'),msg('result'));
  await w.pollOnce();assert.equal(f.events.length,2);assert.equal(f.events[0].meta?.warehouseProgressOnly,true);
  assert.match(f.events[1].text,/progress/);assert.match(f.events[1].text,/result/);
  assert.equal(f.events[1].origin,'external');assert.equal(f.events[1].source,'codexbridge');
  await w.pollOnce();assert.equal(f.events.length,2);assert.equal(f.checkpoint().threads[f.id].offset,statSync(f.file).size);await w.stop();
});
test('restart resumes undelivered records instead of baselining them away',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host);await a.stop();f.append(msg('while stopped'));
  const b=f.world();await b.start(f.host);await b.pollOnce();assert.equal(f.events.length,1);assert.match(f.events[0].text,/while stopped/);await b.stop();
});
test('failed host push preserves intent/cursor and retries fixed batch before later append',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const before=f.checkpoint().threads[f.id].offset;
  f.append(msg('first new'));f.setFailPush(true);await w.pollOnce();assert.equal(f.events.length,0);assert.equal(f.checkpoint().threads[f.id].offset,before);assert.ok(f.checkpoint().pending[f.id]);
  f.append(msg('second new'));f.setFailPush(false);await w.pollOnce();assert.equal(f.events.length,1);assert.doesNotMatch(f.events[0].text,/second new/);
  await w.pollOnce();assert.equal(f.events.length,2);assert.match(f.events[1].text,/second new/);await w.stop();
});
test('saved event plus failed checkpoint does not duplicate after restart and source append',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);f.append(msg('durable result'));
  const runtime=(w as unknown as {runtime:{save:(s:unknown)=>void}}).runtime,save=runtime.save.bind(runtime);
  runtime.save=(state)=>{if(f.events.length)throw new Error('injected checkpoint disk failure');save(state);};
  await w.pollOnce();assert.equal(f.events.length,1);assert.ok(f.checkpoint().pending[f.id]);await w.stop();
  f.append({type:'response_item',payload:{type:'custom_tool_call_output',output:'later append'}},msg('later result'));
  const b=f.world();await b.start(f.host);await b.pollOnce();assert.equal(f.events.length,1);assert.equal(f.checkpoint().pushedEvents,1);
  await b.pollOnce();assert.equal(f.events.length,2);assert.match(f.events[1].text,/later result/);assert.equal(f.checkpoint().pushedEvents,2);await b.stop();
});
test('partial tail waits for LF; invalid complete records retain old cursor and show failure',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const before=f.checkpoint().threads[f.id].offset;
  const row=JSON.stringify(msg('torn 中文 result'));appendFileSync(f.file,row.slice(0,20));await w.pollOnce();assert.equal(f.events.length,0);assert.equal(f.checkpoint().threads[f.id].offset,before);
  appendFileSync(f.file,row.slice(20)+'\n');await w.pollOnce();assert.equal(f.events.length,1);
  const good=f.checkpoint().threads[f.id].offset;appendFileSync(f.file,'{bad json}\n');await w.pollOnce();assert.equal(f.checkpoint().threads[f.id].offset,good);assert.ok(w.status().currentError);await w.stop();
});
test('truncated sources and corrupt checkpoints fail without overwriting recovery evidence',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const before=f.checkpoint().threads[f.id].offset;writeFileSync(f.file,'');await w.pollOnce();assert.equal(f.checkpoint().threads[f.id].offset,before);assert.ok(w.status().currentError);await w.stop();
  const path=join(f.data,'codexbridge','checkpoint.json');writeFileSync(path,'broken checkpoint');await assert.rejects(f.world().start(f.host),/corrupt/);assert.equal(readFileSync(path,'utf8'),'broken checkpoint');
});
test('tool read/search pagination exposes sources and never bypasses workspace boundaries',async()=>{
  const f=fixture();f.append(msg('needle one'),msg('needle two'),msg('needle three'));
  const w=f.world();await w.start(f.host);const list=await f.tool(w,'list',{});assert.equal(list.threads.length,1);assert.equal(list.threads[0].id,f.id);
  const page=await f.tool(w,'read',{threadId:f.id,limit:1});assert.equal(page.items.length,1);assert.equal(page.hasMore,true);
  const first=await f.tool(w,'search',{query:'needle',limit:1});assert.equal(first.matches.length,1);assert.equal(first.truncated,true);
  const second=await f.tool(w,'search',{query:'needle',limit:1,cursor:first.nextCursor});assert.equal(second.matches.length,1);assert.notEqual(first.matches[0].id,second.matches[0].id);
  const bad=await w.tools().find(t=>t.name==='codexbridge_read')!.handler({threadId:randomUUID()},{} as ToolCallContext);assert.equal(typeof bad==='object'&&bad.failed,true);await w.stop();
});
test('new threads discovered after first baseline deliver their new public records',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const id=randomUUID();
  writeFileSync(join(f.sessions,`rollout-${id}.jsonl`),encode({type:'session_meta',payload:{id,cwd:f.workspace}})+encode(msg('new thread result')));
  await w.pollOnce();assert.equal(f.events.length,1);assert.match(f.events[0].text,/new thread result/);await w.stop();
});
test('stop waits for an in-flight host receipt before returning',async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const base=f.host.pushEvent.bind(f.host);
  f.host.pushEvent=async(...args)=>{await gate;return base(...args);};const w=f.world();await w.start(f.host);f.append(msg('in-flight'));
  const poll=w.pollOnce();let stopped=false;const stop=w.stop().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);release();await Promise.all([poll,stop]);assert.equal(f.events.length,1);assert.equal(f.checkpoint().threads[f.id].offset,statSync(f.file).size);
});
test('state directory cannot write into Codex source',async()=>{
  const f=fixture();f.cfg.stateDir=join(f.sessions,'state');await assert.rejects(f.world().start(f.host),/outside source/);assert.equal(f.events.length,0);
});
test('idle threads do not rescan historical message bodies each poll',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);
  const reader=(w as unknown as {reader:{readPage:()=>unknown}}).reader;reader.readPage=()=>{throw new Error('idle body scan should not happen');};
  await w.pollOnce();assert.equal(w.status().currentError,null);assert.equal(f.events.length,0);await w.stop();
});
test('one malformed discovery file cannot block another valid live thread',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);writeFileSync(join(f.sessions,'broken.jsonl'),'{bad}\n');f.append(msg('valid new result'));
  await w.pollOnce();assert.equal(f.events.length,1);assert.ok((w.status().discoveryWarnings as string[]).length);assert.equal(w.status().currentError,null);await w.stop();
});
test('search reports incomplete coverage when message text was clipped',async()=>{
  const f=fixture();f.append(msg('a'.repeat(1024*1024+50)+'needle-at-tail'));const w=f.world();await w.start(f.host);
  const result=await f.tool(w,'search',{query:'needle-at-tail'});assert.equal(result.matches.length,0);assert.equal(result.truncated,true);assert.ok(result.incompleteReasons.length);await w.stop();
});

test('restart uses checkpoint identity before discovery and recovers a saved receipt once despite copies',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host);f.append(msg('durable original result'));
  const runtime=(a as unknown as {runtime:{save:(s:unknown)=>void}}).runtime,save=runtime.save.bind(runtime);
  runtime.save=(state)=>{if(f.events.length)throw new Error('injected checkpoint failure');save(state);};
  await a.pollOnce();assert.equal(f.events.length,1);const pending=f.checkpoint().pending[f.id];assert.ok(pending);await a.stop();
  const copy=join(f.sessions,'000-copy.jsonl');copyFileSync(f.file,copy);appendFileSync(copy,encode(msg('copy-secret')));
  copyFileSync(copy,join(f.sessions,'zzz-copy.jsonl'));f.append(msg('later original result'));
  const b=f.world();await b.start(f.host);assert.equal(b.status().threads,1);
  assert.match((b.status().discoveryWarnings as string[]).join('\n'),/quarantined 2/);
  const listed=await f.tool(b,'list',{});assert.equal(listed.threads.length,1);
  const read=await f.tool(b,'read',{threadId:f.id});assert.doesNotMatch(JSON.stringify(read),/copy-secret/);
  const search=await f.tool(b,'search',{threadId:f.id,query:'copy-secret'});assert.equal(search.matches.length,0);
  await b.pollOnce();assert.equal(f.events.length,1);assert.equal(f.checkpoint().threads[f.id].offset,pending.to);
  assert.equal(f.checkpoint().pending?.[f.id],undefined);assert.equal(f.checkpoint().pushedEvents,1);
  await b.pollOnce();assert.equal(f.events.length,2);assert.match(f.events[1].text,/later original result/);
  assert.equal(b.status().currentError,null);await b.pollOnce();assert.equal(f.events.length,2);await b.stop();
});

test('a newly checkpointed thread becomes an identity anchor without restart',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const id=randomUUID(),file=join(f.sessions,'new-thread.jsonl');
  writeFileSync(file,encode({type:'session_meta',payload:{id,cwd:f.workspace}})+encode(msg('new thread result')));
  await w.pollOnce();assert.ok(f.checkpoint().threads[id]);assert.equal(f.events.length,1);
  copyFileSync(file,join(f.sessions,'new-copy.jsonl'));appendFileSync(file,encode(msg('original continued')));
  await w.pollOnce();assert.equal(f.events.length,2);assert.equal(w.status().currentError,null);
  assert.match(f.events[1].text,/original continued/);assert.equal((await f.tool(w,'list',{})).threads.length,2);await w.stop();
});

test('restarting the same World instance discovers against freshly loaded checkpoint state',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);await w.stop();
  const otherSource=join(f.dir,'other-source');mkdirSync(otherSource);const copy=join(otherSource,'copy.jsonl');
  copyFileSync(f.file,copy);appendFileSync(copy,encode(msg('fresh checkpoint source')));
  const candidate=new CodexRolloutReader({sessionsDir:otherSource,allowedWorkspaces:[f.workspace],deniedWorkspaces:[],includeSubagents:false}).discover()[0];
  // Simulate a separately persisted, validated source checkpoint while stopped.
  // This tests load precedence, not automatic migration of a missing source.
  const checkpoint=f.checkpoint();checkpoint.threads[f.id]={identity:candidate.identity,offset:candidate.baselineOffset};
  writeFileSync(join(f.data,'codexbridge','checkpoint.json'),JSON.stringify(checkpoint));
  // Rename preserves the native identity; copying would create a different one.
  const {renameSync}=await import('node:fs');renameSync(copy,join(f.sessions,'copy.jsonl'));
  await w.start(f.host);const read=await f.tool(w,'read',{threadId:f.id});assert.match(JSON.stringify(read),/fresh checkpoint source/);
  await w.pollOnce();assert.equal(w.status().currentError,null);assert.equal(f.events.length,0);await w.stop();
});

test('unanchored duplicates remain excluded while unrelated tracked work proceeds',async()=>{
  const f=fixture(),w=f.world();await w.start(f.host);const id=randomUUID();
  const line=encode({type:'session_meta',payload:{id,cwd:f.workspace}})+encode(msg('ambiguous-copy-secret'));
  writeFileSync(join(f.sessions,'dup-a.jsonl'),line);writeFileSync(join(f.sessions,'dup-b.jsonl'),line);f.append(msg('known thread continued'));
  await w.pollOnce();assert.equal(w.status().currentError,null);assert.equal(f.events.length,1);assert.equal(f.checkpoint().threads[id],undefined);
  assert.equal((await f.tool(w,'list',{})).threads.length,1);
  const searched=await f.tool(w,'search',{query:'ambiguous-copy-secret'});assert.equal(searched.matches.length,0);await w.stop();
});

test('losing original source retains its cursor and denies read/search even when only a copy remains',async()=>{
  const f=fixture(),a=f.world();await a.start(f.host);const before=f.checkpoint().threads[f.id];await a.stop();
  copyFileSync(f.file,join(f.sessions,'copy.jsonl'));unlinkSync(f.file);
  const b=f.world();await b.start(f.host);await b.pollOnce();assert.deepEqual(f.checkpoint().threads[f.id],before);
  assert.match(String(b.status().currentError),new RegExp(f.id));assert.equal(f.events.length,0);assert.equal((await f.tool(b,'list',{})).threads.length,0);
  for(const [name,args]of [['read',{threadId:f.id}],['search',{threadId:f.id,query:'historical'}]] as const) {
    const result=await b.tools().find(t=>t.name===`codexbridge_${name}`)!.handler(args,{} as ToolCallContext);
    assert.equal(typeof result==='object'&&result.failed,true);
  }
  await b.stop();
});

test('list/read/search keep permission and subagent filters ahead of matching checkpoint identities',async()=>{
  for(const blocked of ['workspace','subagent'] as const) {
    const f=fixture(),privateDir=join(f.workspace,'private');mkdirSync(privateDir);f.cfg.deniedWorkspaces=JSON.stringify([privateDir]);
    const a=f.world();await a.start(f.host);await a.stop();
    writeFileSync(f.file,encode({type:'session_meta',payload:{id:f.id,cwd:blocked==='workspace'?privateDir:f.workspace,...(blocked==='subagent'?{parent_thread_id:randomUUID()}:{})}})+encode(msg('filtered-secret')));
    const trusted=new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.workspace],deniedWorkspaces:[],includeSubagents:true}).discover()[0];
    const checkpoint=f.checkpoint();checkpoint.threads[f.id]={identity:trusted.identity,offset:trusted.baselineOffset};
    writeFileSync(join(f.data,'codexbridge','checkpoint.json'),JSON.stringify(checkpoint));
    writeFileSync(join(f.sessions,'public-copy.jsonl'),encode({type:'session_meta',payload:{id:f.id,cwd:f.workspace}})+encode(msg('replacement-secret')));
    const b=f.world();await b.start(f.host);assert.equal((await f.tool(b,'list',{})).threads.length,0);
    assert.equal((await f.tool(b,'search',{query:'secret'})).matches.length,0);
    const result=await b.tools().find(t=>t.name==='codexbridge_read')!.handler({threadId:f.id},{} as ToolCallContext);assert.equal(typeof result==='object'&&result.failed,true);
    await b.pollOnce();assert.equal(f.events.length,0);assert.deepEqual(f.checkpoint().threads[f.id],checkpoint.threads[f.id]);await b.stop();
  }
});
