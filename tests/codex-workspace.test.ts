import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { WorkspaceFiles, WorkspaceFilesError, WORKSPACE_LIMITS } from '../src/workspace.ts';
import { scrubText } from '../src/scrub.ts';
import { CodexBridgeWorld } from '../src/world.ts';
import { codexBridgeDefaults, resolveCodexBridgeConfig } from '../src/config.ts';

const scratch=join(process.cwd(),'scratch','codex-workspace-tests');mkdirSync(scratch,{recursive:true});
const code=(expected:string)=>(error:unknown)=>error instanceof WorkspaceFilesError&&error.code===expected;
function fixture(maxFileBytes=1024*1024) {
  const dir=mkdtempSync(join(scratch,'run-')),root=join(dir,'project'),denied=join(root,'restricted');mkdirSync(root);mkdirSync(denied);
  const files=new WorkspaceFiles({roots:[root],denied:[denied],maxFileBytes,scrub:scrubText});
  const put=(path:string,text:string|Buffer)=>{const full=join(root,path);mkdirSync(parse(full).dir,{recursive:true});writeFileSync(full,text);return full;};
  return {dir,root,denied,files,put};
}
test('project text tools read scrubbed bounded content, paginate UTF-16 safely, and never mutate files',()=>{
  const f=fixture(),file=f.put('README.md','alpha😀 omega\napi_key="synthetic-private-secret"');
  const before=createHash('sha256').update(readFileSync(file)).digest('hex');
  const first=f.files.read({root:f.root,path:'README.md',maxChars:6});assert.equal(first.content,'alpha');assert.equal(first.nextOffset,5);
  const second=f.files.read({root:f.root,path:'README.md',offset:first.nextOffset,maxChars:2});assert.equal(second.content,'😀');assert.equal(second.nextOffset,7);
  assert.throws(()=>f.files.read({root:f.root,path:'README.md',offset:6}),code('INVALID_OFFSET'));
  assert.throws(()=>f.files.read({root:f.root,path:'README.md',offset:5,maxChars:1}),code('INVALID_ARGUMENT'));
  const whole=f.files.read({root:f.root,path:'README.md'});assert.doesNotMatch(String(whole.content),/synthetic-private-secret/);assert.match(String(whole.content),/REDACTED/);
  const secret=f.files.search({root:f.root,path:'.',query:'synthetic-private-secret'});assert.deepEqual(secret.matches,[]);
  const literal=f.files.search({root:f.root,path:'.',query:'alpha.*'});assert.deepEqual(literal.matches,[]);
  const match=f.files.search({root:f.root,path:'.',query:'omega'});assert.equal((match.matches as unknown[]).length,1);assert.doesNotMatch(JSON.stringify(match),/synthetic-private-secret/);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),before);f.files.close();
});
test('all tools reject unknown parameters, missing explicit paths and unauthorized roots',()=>{
  const f=fixture();f.put('a.txt','public');
  for(const name of ['list','read','search'] as const) {
    const base={root:f.root,path:name==='read'?'a.txt':'.',...(name==='search'?{query:'public'}:{})};
    assert.throws(()=>f.files[name]({...base,execute:true}),code('INVALID_ARGUMENT'));
    assert.throws(()=>f.files[name]({...base,path:undefined}),code('INVALID_ARGUMENT'));
    assert.throws(()=>f.files[name]({...base,root:f.dir}),code('INVALID_ROOT'));
  }
  f.files.close();
});
test('traversal absolute paths Windows ADS devices trailing dots and hidden paths fail closed',()=>{
  const f=fixture();f.put('a.txt','public');
  for(const path of ['../a.txt','x/../a.txt','/a.txt',join(f.root,'a.txt'),'C:\\a.txt','a.txt:stream','CON.txt','LPT1.md','x/aux.txt','a.txt.','a.txt ','x//a.txt','x\\..\\a.txt'])
    assert.throws(()=>f.files.read({root:f.root,path}),code('INVALID_PATH'));
  for(const path of ['.env','.git/config','credentials/service.json','logs/error.txt','sessions/a.json','backup/a.md'])
    assert.throws(()=>f.files.read({root:f.root,path}),code('EXCLUDED'));
  f.files.close();
});
test('denied paths and default excluded folders/extensions are skipped without returning their metadata',()=>{
  const f=fixture();f.put('public.ts','public');f.put('restricted/private.md','secret');
  for(const path of ['node_modules/a.ts','venv/a.py','build/a.js','dist/a.js','.cache/a.txt','.git/a.txt','logs/a.txt','audit/a.json','sessions/a.jsonl','archive/a.txt','secrets/secret.json','credentials.json','token.json','.env','id_rsa','a.db','a.jsonl','a.log','archive.zip','binary.png'])f.put(path,'excluded');
  assert.throws(()=>f.files.read({root:f.root,path:'restricted/private.md'}),code('DENIED'));
  const listed=f.files.list({root:f.root,path:'.',limit:100});assert.deepEqual((listed.entries as {path:string}[]).map(e=>e.path),['public.ts']);
  const searched=f.files.search({root:f.root,path:'.',query:'excluded'});assert.deepEqual(searched.matches,[]);assert.doesNotMatch(JSON.stringify(searched),/credentials.json|private.md/);f.files.close();
});
test('the protected conversation-record directory is excluded from project list read and search',()=>{
  const f=fixture();f.put('对话记录/private.md','protected-conversation-only');f.put('public.md','public');
  assert.throws(()=>f.files.read({root:f.root,path:'对话记录/private.md'}),code('EXCLUDED'));
  assert.throws(()=>f.files.list({root:f.root,path:'对话记录'}),code('EXCLUDED'));
  assert.throws(()=>f.files.search({root:f.root,path:'对话记录',query:'protected'}),code('EXCLUDED'));
  const listed=f.files.list({root:f.root,path:'.'});assert.equal((listed.entries as {path:string}[]).some(e=>e.path==='对话记录'),false);
  assert.deepEqual(f.files.search({root:f.root,path:'.',query:'protected-conversation-only'}).matches,[]);f.files.close();
});
test('retargeting a denied junction excludes its new direct target and retains the original exclusions',()=>{
  const f=fixture(),first=join(f.root,'first-target'),second=join(f.root,'second-target'),alias=join(f.root,'policy-link');
  mkdirSync(first);mkdirSync(second);writeFileSync(join(first,'private.md'),'first-private');writeFileSync(join(second,'private.md'),'second-private');
  const type=process.platform==='win32'?'junction':'dir';symlinkSync(first,alias,type);
  const files=new WorkspaceFiles({roots:[f.root],denied:[f.denied,alias],maxFileBytes:1024,scrub:scrubText});
  assert.throws(()=>files.read({root:f.root,path:'first-target/private.md'}),code('DENIED'));
  assert.equal(files.read({root:f.root,path:'second-target/private.md'}).content,'second-private');
  unlinkSync(alias);symlinkSync(second,alias,type);
  assert.throws(()=>files.read({root:f.root,path:'second-target/private.md'}),code('DENIED'));
  assert.throws(()=>files.read({root:f.root,path:'first-target/private.md'}),code('DENIED'));
  assert.deepEqual(files.search({root:f.root,path:'.',query:'private'}).matches,[]);
  const list=files.list({root:f.root,path:'.'});assert.deepEqual(list.entries,[]);
  unlinkSync(alias);mkdirSync(alias);writeFileSync(join(alias,'private.md'),'logical-path-remains-denied');
  assert.throws(()=>files.read({root:f.root,path:'policy-link/private.md'}),code('DENIED'));
  files.close();f.files.close();
});
test('symlink and junction roots and traversal are rejected; hardlinked text cannot be read',()=>{
  const f=fixture(),outside=join(f.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'private.txt'),'private');
  symlinkSync(outside,join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.files.read({root:f.root,path:'linked/private.txt'}),code('UNSAFE_LINK'));
  assert.throws(()=>new WorkspaceFiles({roots:[join(f.root,'linked')],denied:[],maxFileBytes:100,scrub:scrubText}),code('UNSAFE_LINK'));
  const original=f.put('a.txt','public');linkSync(original,join(f.root,'copy.txt'));
  assert.throws(()=>f.files.read({root:f.root,path:'a.txt'}),code('EXCLUDED'));
  assert.throws(()=>f.files.read({root:f.root,path:'copy.txt'}),code('EXCLUDED'));assert.deepEqual(f.files.search({root:f.root,path:'.',query:'private'}).matches,[]);f.files.close();
});
test('replacing an authorized root rejects new content and existing cursors',()=>{
  const f=fixture();f.put('a.txt','original');f.put('b.txt','original');const page=f.files.list({root:f.root,path:'.',limit:1});assert.ok(page.nextCursor);
  renameSync(f.root,f.root+'-original');mkdirSync(f.root);writeFileSync(join(f.root,'a.txt'),'replacement');
  assert.throws(()=>f.files.read({root:f.root,path:'a.txt'}),code('SOURCE_CHANGED'));
  assert.throws(()=>f.files.list({root:f.root,path:'.',cursor:page.nextCursor}),code('SOURCE_CHANGED'));f.files.close();
});
test('filesystem root home and sensitive-source directories cannot become project file roots',()=>{
  const f=fixture();
  for(const root of [parse(f.root).root,homedir(),join(f.root,'.codex'),join(f.root,'sessions'),join(f.root,'certificates')])
    assert.throws(()=>new WorkspaceFiles({roots:[root],denied:[],maxFileBytes:100,scrub:scrubText}),code('INVALID_ROOT'));
  assert.throws(()=>new WorkspaceFiles({roots:[f.root],denied:[f.root],maxFileBytes:100,scrub:scrubText}),code('DENIED'));
  assert.throws(()=>new WorkspaceFiles({roots:[f.root],denied:[],maxFileBytes:WORKSPACE_LIMITS.maxFileBytes+1,scrub:scrubText}),code('INVALID_CONFIG'));f.files.close();
});
test('non-UTF8 NUL private keys and oversized text are refused with explicit coverage gaps',()=>{
  const f=fixture(100);f.put('invalid.txt',Buffer.from([0xff,0xfe]));f.put('zero-byte.txt',Buffer.from([65,0,66]));f.put('huge.txt','h'.repeat(101));
  for(const [path,text]of [['rsa.txt','-----BEGIN RSA PRIVATE KEY-----'],['openssh.md','-----BEGIN OPENSSH PRIVATE KEY-----'],['pgp.txt','-----BEGIN PGP PRIVATE KEY BLOCK-----'],['putty.txt','PuTTY-User-Key-File-3: ssh-rsa']]) {
    f.put(path,text);assert.throws(()=>f.files.read({root:f.root,path}),code('PRIVATE_KEY'));
  }
  assert.throws(()=>f.files.read({root:f.root,path:'invalid.txt'}),code('NON_UTF8'));
  assert.throws(()=>f.files.read({root:f.root,path:'zero-byte.txt'}),code('BINARY_FILE'));
  assert.throws(()=>f.files.read({root:f.root,path:'huge.txt'}),code('FILE_TOO_LARGE'));
  const result=f.files.search({root:f.root,path:'.',query:'missing'});assert.equal(result.truncated,true);
  for(const reason of ['NON_UTF8','BINARY_FILE','FILE_TOO_LARGE','PRIVATE_KEY'])assert.ok((result.incompleteReasons as string[]).includes(reason));f.files.close();
});
test('oversized files are rejected before any file body read and in-read changes are detected',()=>{
  const f=fixture(100);const file=f.put('large.txt','x'.repeat(101)),normal=f.put('normal.txt','normal content');
  const originalRead=fs.readSync;let reads=0;
  try {
    fs.readSync=((...args:Parameters<typeof fs.readSync>)=>{reads++;return (originalRead as Function)(...args);}) as typeof fs.readSync;syncBuiltinESMExports();
    assert.throws(()=>f.files.read({root:f.root,path:'large.txt'}),code('FILE_TOO_LARGE'));assert.equal(reads,0);
    let changed=false;fs.readSync=((...args:Parameters<typeof fs.readSync>)=>{const n=(originalRead as Function)(...args);if(!changed){changed=true;appendFileSync(normal,' changed');}return n;}) as typeof fs.readSync;syncBuiltinESMExports();
    assert.throws(()=>f.files.read({root:f.root,path:'normal.txt'}),code('SOURCE_CHANGED'));
  } finally {fs.readSync=originalRead;syncBuiltinESMExports();f.files.close();}
  assert.equal(readFileSync(file,'utf8').length,101);
});
test('list/search cursors bind operation root path and query and cannot replay after use or close',()=>{
  const f=fixture();for(let i=0;i<4;i++)f.put(`f${i}.txt`,'needle');mkdirSync(join(f.root,'sub'));
  const list=f.files.list({root:f.root,path:'.',limit:1}),token=list.nextCursor;assert.ok(token);
  assert.throws(()=>f.files.list({root:f.root,path:'sub',cursor:token}),code('INVALID_CURSOR'));
  assert.throws(()=>f.files.search({root:f.root,path:'.',query:'needle',cursor:token}),code('INVALID_CURSOR'));
  const next=f.files.list({root:f.root,path:'.',cursor:token,limit:1});assert.ok(next.nextCursor);
  assert.throws(()=>f.files.list({root:f.root,path:'.',cursor:token}),code('INVALID_CURSOR'));
  const search=f.files.search({root:f.root,path:'.',query:'needle',limit:1});assert.ok(search.nextCursor);
  assert.throws(()=>f.files.search({root:f.root,path:'.',query:'other',cursor:search.nextCursor}),code('INVALID_CURSOR'));
  f.files.close();assert.throws(()=>f.files.list({root:f.root,path:'.',cursor:next.nextCursor}),code('INVALID_CURSOR'));
  assert.throws(()=>f.files.search({root:f.root,path:'.',query:'needle',cursor:search.nextCursor}),code('INVALID_CURSOR'));
});
test('cursor capacity refuses new traversals while existing cursors remain usable and TTL expires explicitly',()=>{
  const f=fixture();f.put('a.txt','needle');f.put('b.txt','needle');const cursors:unknown[]=[];
  for(let i=0;i<WORKSPACE_LIMITS.cursors;i++)cursors.push(f.files.list({root:f.root,path:'.',limit:1}).nextCursor);
  assert.throws(()=>f.files.list({root:f.root,path:'.',limit:1}),code('CURSOR_LIMIT'));
  assert.ok(f.files.list({root:f.root,path:'.',cursor:cursors[0],limit:1}));
  const now=Date.now;try{Date.now=()=>now()+WORKSPACE_LIMITS.cursorLifetimeMs+1;assert.throws(()=>f.files.list({root:f.root,path:'.',cursor:cursors[1]}),code('INVALID_CURSOR'));}finally{Date.now=now;f.files.close();}
});
test('search enforces file and byte budgets including invalid file bodies and resumes without rescanning results',()=>{
  const f=fixture(4*1024*1024);for(let i=0;i<40;i++)f.put(`small-${i}.txt`,'absent');
  let page=f.files.search({root:f.root,path:'.',query:'needle'});assert.equal(page.scannedFiles,32);assert.ok(page.nextCursor);
  page=f.files.search({root:f.root,path:'.',query:'needle',cursor:page.nextCursor});assert.equal(page.scannedFiles,8);assert.equal(page.nextCursor,null);
  const g=fixture(4*1024*1024);for(let i=0;i<3;i++)g.put(`invalid-${i}.txt`,Buffer.alloc(3*1024*1024,0xff));
  let large=g.files.search({root:g.root,path:'.',query:'needle'});assert.equal(large.scannedBytes,6*1024*1024);assert.ok(large.nextCursor);
  large=g.files.search({root:g.root,path:'.',query:'needle',cursor:large.nextCursor});assert.equal(large.scannedBytes,3*1024*1024);assert.equal(large.nextCursor,null);
  f.files.close();g.files.close();
});
test('metadata scans are bounded and recursively searched text stays reachable through continuations',()=>{
  const f=fixture();for(let i=0;i<600;i++)f.put(`f${i}.bin`,'excluded');f.put('nested/readme.md','needle');
  const results=[];let cursor:unknown;let pages=0;
  do {const page=f.files.search({root:f.root,path:'.',query:'needle',...(cursor?{cursor}:{})});assert.ok((page.scannedEntries as number)<=WORKSPACE_LIMITS.entryScan);results.push(...page.matches as unknown[]);cursor=page.nextCursor;pages++;assert.ok(pages<10);}while(cursor);
  assert.ok(pages>=2);assert.equal(results.length,1);f.files.close();
});

function worldFixture() {
  const f=fixture(),sessions=join(f.dir,'rollouts'),data=join(f.dir,'state');mkdirSync(sessions);mkdirSync(data);
  const id=randomUUID();writeFileSync(join(sessions,'source.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:f.root}})+'\n');
  const cfg={...codexBridgeDefaults(),enabled:true,sessionsDir:sessions,allowedWorkspaces:JSON.stringify([parse(f.root).root]),deniedWorkspaces:JSON.stringify([f.denied]),watchIntervalSeconds:0};
  let pushes=0;const host={store:{grep:()=>[]},pushEvent:async()=>{pushes++;throw new Error('File tools must never push');}} as unknown as WorldHost;
  const world=()=>new CodexBridgeWorld({cfg,dataDir:data});
  return {...f,sessions,data,id,cfg,host,world,pushes:()=>pushes,checkpoint:()=>JSON.parse(readFileSync(join(data,'codexbridge','checkpoint.json'),'utf8'))};
}
test('file tools default off and broad legacy conversation scope can opt into narrow file roots without changing checkpoint',async()=>{
  const f=worldFixture();f.put('README.md','needle');const a=f.world();await a.start(f.host);
  assert.equal(codexBridgeDefaults().workspaceFilesEnabled,false);assert.equal(codexBridgeDefaults().workspaceFileRoots,'[]');assert.equal(codexBridgeDefaults().workspaceMaxFileBytes,1024*1024);
  assert.equal(a.tools().some(t=>t.name==='codexbridge_file_read'),false);const before=f.checkpoint();await a.stop();
  f.cfg.workspaceFilesEnabled=true;f.cfg.workspaceFileRoots=JSON.stringify([f.root]);const b=f.world();await b.start(f.host);
  assert.equal(f.checkpoint().scopeHash,before.scopeHash);assert.deepEqual(f.checkpoint().threads,before.threads);
  for(const [name,args]of [['files_list',{root:f.root,path:'.'}],['file_read',{root:f.root,path:'README.md'}],['files_search',{root:f.root,path:'.',query:'needle'}]] as const) {
    const result=await b.tools().find(t=>t.name===`codexbridge_${name}`)!.handler(args,{} as ToolCallContext);assert.equal(typeof result,'string');
  }
  assert.equal(f.pushes(),0);assert.deepEqual(f.checkpoint().threads,before.threads);await b.stop();f.files.close();
});
test('file roots cannot extend chat authorization or overlap custom source/state paths',async()=>{
  const f=worldFixture();f.cfg.workspaceFilesEnabled=true;f.cfg.allowedWorkspaces=JSON.stringify([f.root]);
  assert.throws(()=>resolveCodexBridgeConfig(f.cfg),/workspaceFileRoots/);
  f.cfg.workspaceFileRoots=JSON.stringify([f.dir]);await assert.rejects(f.world().start(f.host),/inside the allowed/);
  f.cfg.allowedWorkspaces=JSON.stringify([f.dir]);f.cfg.workspaceFileRoots=JSON.stringify([f.sessions]);await assert.rejects(f.world().start(f.host),/DENIED/);
  f.cfg.workspaceFileRoots=JSON.stringify([f.root]);f.cfg.workspaceMaxFileBytes=8*1024*1024+1;assert.throws(()=>resolveCodexBridgeConfig(f.cfg),/workspaceMaxFileBytes/);f.files.close();
});
