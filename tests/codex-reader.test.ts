import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRolloutReader, CodexReaderError } from '../src/reader.ts';
import { scrubText } from '../src/scrub.ts';

const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'codex-reader-tests');
mkdirSync(scratch, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(scratch, 'run-'));
  const sessions = join(dir, 'sessions'), allowed = join(dir, 'workspace'), denied = join(allowed, 'private');
  mkdirSync(sessions); mkdirSync(allowed); mkdirSync(denied);
  const id = randomUUID(), file = join(sessions, `rollout-${id}.jsonl`);
  const meta = { type: 'session_meta', timestamp: '2026-10-05T00:00:00Z', payload: { id, cwd: allowed, source: 'vscode' } };
  const encode = (row: unknown) => JSON.stringify(row) + '\n';
  const write = (...rows: unknown[]) => writeFileSync(file, rows.map(encode).join(''));
  const reader = (includeSubagents = false) => new CodexRolloutReader({ sessionsDir: sessions, allowedWorkspaces: [allowed], deniedWorkspaces: [denied], includeSubagents });
  return { dir, sessions, allowed, denied, id, file, meta, encode, write, reader };
}
function message(role: string, text: string, phase?: string, kinds?: string[]) {
  return { type: 'response_item', timestamp: '2026-10-05T00:00:01Z', payload: {
    type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-a', ...(kinds ? { content_item_kinds: kinds } : {}) },
  } };
}
const ctx = (cwd: string) => ({ type: 'turn_context', payload: { cwd, turn_id: 'turn-a' } });
const event = (type: string, extra = {}) => ({ type: 'event_msg', payload: { type, turn_id: 'turn-a', ...extra } });
const code = (expected: string) => (err: unknown) => err instanceof CodexReaderError && err.code === expected;

test('exports all public user/commentary/final messages and lifecycle, never duplicate/tool/reasoning text', () => {
  const f = fixture();
  f.write(f.meta, ctx(f.allowed), message('user', 'request', undefined, ['user.text']), message('assistant', 'progress', 'commentary'),
    { type: 'response_item', payload: { type: 'reasoning', summary: 'reasoning-secret' } }, message('assistant', 'analysis-secret', 'analysis'),
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'tool-secret' } },
    event('item_completed', { item: { type: 'AgentMessage', content: 'duplicate-secret' } }),
    message('assistant', 'final result', 'final_answer'), event('task_complete', { last_agent_message: 'final duplicate' }));
  const r = f.reader(); assert.equal(r.discover().length, 1);
  const page = r.readPage(f.id);
  assert.deepEqual(page.items.map(x => x.text ?? x.state), ['request', 'progress', 'final result', 'completed']);
  assert.equal(page.hasMore, false); assert.equal(page.tornTail, false);
  assert.equal(JSON.stringify(page).includes('secret'), false);
  assert.equal(page.items[2].phase, 'final_answer'); assert.equal(page.items[0].turnId, 'turn-a');
});

test('filters modern injected blocks and legacy pure machine messages while retaining question replies', () => {
  const f = fixture();
  f.write(f.meta, message('user', '<environment_context>private metadata</environment_context>', undefined, ['environments.environment_context']),
    message('user', '<recommended_plugins>plugin metadata</recommended_plugins>'), message('developer', 'skills-secret'),
    message('user', '# AGENTS.md instructions for project\nprivate rules'),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'machine block' }, { type: 'input_text', text: 'human block' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['additional_content.codex_apps_open_page', 'user.text'] } } },
    message('user', '<send_user_message_question_reply>the answer</send_user_message_question_reply>', undefined, ['user.text']),
    message('assistant', 'final after injection', 'final_answer'));
  const page = f.reader().readPage(f.id);
  assert.deepEqual(page.items.map(x => x.text), ['human block', '<send_user_message_question_reply>the answer</send_user_message_question_reply>', 'final after injection']);
});

test('uses first meta as identity and skips copied-parent subagent history by default', () => {
  const f = fixture(), parent = randomUUID();
  const childMeta = { ...f.meta, payload: { ...f.meta.payload, agent_path: '/root/child', parent_thread_id: parent, source: { subagent: {} } } };
  f.write(childMeta, { ...f.meta, payload: { ...f.meta.payload, id: parent } }, message('assistant', 'copied history', 'final_answer'));
  assert.deepEqual(f.reader().discover(), []);
  const r = f.reader(true); assert.equal(r.discover()[0].id, f.id); assert.throws(() => r.readPage(parent), code('THREAD_NOT_FOUND'));
});

test('rejects caller paths and non-boundary offsets; resumes using stable byte IDs', () => {
  const f = fixture(); f.write(f.meta, message('user', '中文 input'), message('assistant', '中文 final', 'final_answer'));
  const r = f.reader(); const first = r.readPage(f.id, { limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.hasMore, true);
  const second = r.readPage(f.id, { offset: first.nextOffset, limit: 1 });
  assert.equal(second.items[0].text, '中文 final');
  assert.equal(second.items[0].id, `${f.id}:${first.nextOffset}`);
  assert.deepEqual(r.readPage(f.id, { offset: first.nextOffset }).items, second.items);
  assert.throws(() => r.readPage('../rollout.jsonl'), code('INVALID_THREAD_ID'));
  assert.throws(() => r.readPage(f.id, { offset: first.nextOffset - 1 }), code('INVALID_OFFSET'));
});

test('never advances over a torn multibyte tail and picks it up after completion', () => {
  const f = fixture(); f.write(f.meta, message('user', 'before tail'));
  const tail = Buffer.from(f.encode(message('assistant', '中文 final', 'final_answer')));
  const split = tail.indexOf(Buffer.from('中')) + 1;
  appendFileSync(f.file, tail.subarray(0, split));
  const r = f.reader(), first = r.readPage(f.id);
  assert.equal(first.tornTail, true); assert.equal(first.hasMore, false); assert.equal(first.items.length, 1);
  appendFileSync(f.file, tail.subarray(split));
  const completed = r.readPage(f.id, { offset: first.nextOffset });
  assert.equal(completed.items[0].text, '中文 final'); assert.equal(completed.tornTail, false);
});

test('malformed complete lines explicitly fail both fresh and resumed reads', () => {
  const f = fixture(); f.write(f.meta); const start = Buffer.byteLength(f.encode(f.meta));
  appendFileSync(f.file, '{broken json}\n');
  const r = f.reader(); assert.throws(() => r.readPage(f.id), code('MALFORMED_LINE'));
  assert.throws(() => r.readPage(f.id, { offset: start + Buffer.byteLength('{broken json}\n') }), code('MALFORMED_LINE'));
});

test('page text budget is total and any clipped message is explicit', () => {
  const f = fixture(); f.write(f.meta, message('user', 'abc'), message('assistant', 'defghi', 'commentary'), message('assistant', 'last', 'final_answer'));
  const r = f.reader(), first = r.readPage(f.id, { maxChars: 5 });
  assert.deepEqual(first.items.map(x => x.text), ['abc', 'de']); assert.equal(first.items[1].truncated, true);
  assert.equal(first.truncated, true); assert.equal(first.hasMore, true);
  assert.equal(r.readPage(f.id, { offset: first.nextOffset }).items[0].text, 'last');
});

test('first complete record may finish beyond its byte target without swallowing the following record', () => {
  const f = fixture(); f.write(f.meta, message('user', 'a long enough message'), message('assistant', 'final', 'final_answer'));
  const metaEnd = Buffer.byteLength(f.encode(f.meta));
  const r = f.reader();
  const page=r.readPage(f.id,{offset:metaEnd,maxBytes:12});
  assert.equal(page.items[0].text,'a long enough message');assert.equal(page.items.length,1);
  assert.equal(page.budgetExceeded,true);assert.equal(page.budgetOverrunBytes,page.bytesScanned-12);
  assert.equal(r.readPage(f.id,{offset:page.nextOffset}).items[0].text,'final');
});

test('denied workspace overrides allow root, and similar path prefix never grants access', () => {
  const f = fixture(); f.write({ ...f.meta, payload: { ...f.meta.payload, cwd: f.denied } }, message('user', 'private'));
  assert.deepEqual(f.reader().discover(), []);
  const similar = f.allowed + '-other'; mkdirSync(similar);
  f.write({ ...f.meta, payload: { ...f.meta.payload, cwd: similar } }, message('user', 'outside'));
  assert.deepEqual(f.reader().discover(), []);
});

test('turn cwd changes stay filtered across pagination and can return to permitted workspace', () => {
  const f = fixture(); f.write(f.meta, ctx(f.allowed), message('user', 'first'), ctx(f.denied), message('user', 'private turn'),
    message('assistant', 'private final', 'final_answer'), ctx(f.allowed), message('assistant', 'public final', 'final_answer'));
  const r = f.reader(), first = r.readPage(f.id, { limit: 1 });
  const second = r.readPage(f.id, { offset: first.nextOffset });
  assert.deepEqual(second.items.map(x => x.text), ['public final']);
});

test('records actual turn cwd when a thread moves between two allowed workspaces', () => {
  const f = fixture(), other = join(f.dir, 'other-workspace'); mkdirSync(other);
  f.write(f.meta, ctx(f.allowed), message('user', 'first workspace'), ctx(other), message('assistant', 'second workspace', 'final_answer'), event('task_complete'));
  const r = new CodexRolloutReader({ sessionsDir: f.sessions, allowedWorkspaces: [f.allowed, other], deniedWorkspaces: [f.denied], includeSubagents: false });
  const page = r.readPage(f.id);
  assert.deepEqual(page.items.map(x => x.cwd), [f.allowed, other, other]);
  assert.deepEqual(page.items.map(x => x.text ?? x.state), ['first workspace', 'second workspace', 'completed']);
  const later = r.readPage(f.id, { offset: page.items[1].offset });
  assert.equal(later.items[0].cwd, other);
});

test('realpath denies workspace aliases and source directory junctions are skipped', () => {
  const f = fixture(), alias = join(f.dir, 'alias');
  symlinkSync(f.denied, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.write({ ...f.meta, payload: { ...f.meta.payload, cwd: alias } }, message('user', 'private aliased'));
  assert.deepEqual(f.reader().discover(), []);
  const outer = join(f.dir, 'outside'); mkdirSync(outer);
  writeFileSync(join(outer, 'rollout.jsonl'), f.encode(f.meta));
  symlinkSync(outer, join(f.sessions, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(f.reader().discover(), []);
});

test('protected lexical junction remains denied after its target changes', () => {
  const f = fixture(), first = join(f.allowed, 'first'), second = join(f.allowed, 'second'), alias = join(f.allowed, 'protected-alias');
  mkdirSync(first); mkdirSync(second);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(first, alias, linkType);
  const r = new CodexRolloutReader({ sessionsDir: f.sessions, allowedWorkspaces: [f.allowed], deniedWorkspaces: [alias], includeSubagents: false });
  unlinkSync(alias); symlinkSync(second, alias, linkType);
  f.write({ ...f.meta, payload: { ...f.meta.payload, cwd: alias } }, message('user', 'protected alias'));
  assert.deepEqual(r.discover(), []);
});

test('unchanged file metadata cache rechecks cwd realpath after junction retarget', () => {
  const f = fixture(), publicTarget = join(f.allowed, 'public'), alias = join(f.allowed, 'moving-alias'); mkdirSync(publicTarget);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(publicTarget, alias, linkType);
  f.write({ ...f.meta, payload: { ...f.meta.payload, cwd: alias } }, message('user', 'initially public'));
  const r = f.reader(); assert.equal(r.discover().length, 1); assert.equal(r.discover().length, 1);
  unlinkSync(alias); symlinkSync(f.denied, alias, linkType);
  assert.deepEqual(r.discover(), []);
});

test('append keeps source identity stable and advances baseline only over complete lines', () => {
  const f = fixture(); f.write(f.meta, message('user', 'initial'));
  const r = f.reader(), first = r.discover()[0];
  appendFileSync(f.file, f.encode(message('assistant', 'appended final', 'final_answer')));
  const next = r.discover()[0];
  assert.equal(next.identity, first.identity); assert.ok(next.baselineOffset > first.baselineOffset);
  assert.equal(r.readPage(f.id, { offset: first.baselineOffset }).items[0].text, 'appended final');
  appendFileSync(f.file, '{pending');
  const torn = r.discover()[0]; assert.equal(torn.identity, first.identity); assert.equal(torn.baselineOffset, next.baselineOffset);
  const tailPage = r.readPage(f.id, { offset: torn.baselineOffset, maxBytes: 2 });
  assert.equal(tailPage.hasMore, false); assert.equal(tailPage.tornTail, true); assert.equal(tailPage.nextOffset, torn.baselineOffset);
});

test('detects first-meta replacement and fails on ambiguous same-thread source files', () => {
  const f = fixture(); f.write(f.meta, message('user', 'initial'));
  const r = f.reader(); r.discover();
  f.write({ ...f.meta, payload: { ...f.meta.payload, source: 'changed' } }, message('user', 'replaced'));
  assert.throws(() => r.readPage(f.id), code('SOURCE_CHANGED'));
  writeFileSync(join(f.sessions, 'duplicate.jsonl'), f.encode(f.meta));
  assert.deepEqual(r.discover(), []); assert.equal(r.diagnostics.length, 1);
});

test('saved identity selects the original among two or three copies regardless of discovery order or mtime', () => {
  for (const name of ['000-original.jsonl', 'zzz-original.jsonl']) for (const count of [2, 3]) {
    const f = fixture(); f.write(f.meta, message('assistant', 'original only', 'final_answer'));
    const identity = f.reader().discover()[0].identity;
    const original = join(f.sessions, name); renameSync(f.file, original);
    for (let i = 1; i < count; i++) {
      const copy = join(f.sessions, `copy-${i}.jsonl`); copyFileSync(original, copy);
      appendFileSync(copy, f.encode(message('assistant', 'copy must remain hidden', 'final_answer')));
      utimesSync(copy, new Date('2030-01-01'), new Date('2030-01-01'));
    }
    const r = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false,identityAnchors:()=>({[f.id]:{identity}})});
    // Implicit discovery must use the same durable anchor as explicit discovery.
    assert.deepEqual(r.readPage(f.id).items.map(i=>i.text), ['original only']);
    const found = r.discover(); assert.equal(found.length, 1); assert.equal(found[0].file, original);
    assert.match(r.diagnostics.join('\n'), new RegExp(`quarantined ${count-1} other`));
    assert.deepEqual(f.reader().discover(), []);
  }
});

test('persisted identity never falls back to copies after the original disappears, including a sole remaining copy', () => {
  for (const copies of [1, 2]) {
    const f = fixture(); f.write(f.meta, message('assistant', 'original', 'final_answer'));
    const identity = f.reader().discover()[0].identity;
    for (let i=0;i<copies;i++) copyFileSync(f.file, join(f.sessions, `copy-${i}.jsonl`));
    unlinkSync(f.file);
    const r = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false,identityAnchors:()=>({[f.id]:{identity}})});
    assert.deepEqual(r.discover(), []); assert.match(r.diagnostics.join('\n'), /matched 0/);
    assert.throws(()=>r.readPage(f.id), code('THREAD_NOT_FOUND'));
  }
});

test('two matching hard-link identities remain ambiguous even with a persisted anchor', () => {
  const f = fixture(); f.write(f.meta, message('assistant', 'original', 'final_answer'));
  const identity = f.reader().discover()[0].identity; linkSync(f.file, join(f.sessions,'hardlink.jsonl'));
  const r = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false,identityAnchors:()=>({[f.id]:{identity}})});
  assert.deepEqual(r.discover(), []); assert.match(r.diagnostics.join('\n'), /matched 2 of 2/);
  assert.throws(()=>r.readPage(f.id), code('THREAD_NOT_FOUND'));
});

test('changed durable anchor invalidates an already indexed source and stays live for implicit discovery', () => {
  const f = fixture(); f.write(f.meta, message('assistant', 'original', 'final_answer'));
  let anchors:Record<string,{identity:string}>={};
  const r = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false,identityAnchors:()=>anchors});
  const identity = r.discover()[0].identity;
  anchors = {[f.id]:{identity:'unavailable-identity'}};
  assert.throws(()=>r.readPage(f.id), code('THREAD_NOT_FOUND'));
  anchors = {[f.id]:{identity}};
  copyFileSync(f.file, join(f.sessions,'copy.jsonl'));
  assert.equal(r.readPage(f.id).items[0].text, 'original');
});

test('identity resolution cannot re-admit a denied or subagent source', () => {
  for (const blocked of ['workspace', 'subagent'] as const) {
    const f = fixture();
    f.write({...f.meta,payload:{...f.meta.payload,...(blocked==='workspace'?{cwd:f.denied}:{parent_thread_id:randomUUID()})}}, message('assistant','private','final_answer'));
    const trusted = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[],includeSubagents:true}).discover()[0];
    // A valid public copy with the same UUID cannot stand in for the filtered anchor.
    writeFileSync(join(f.sessions,'public-copy.jsonl'), f.encode(f.meta)+f.encode(message('assistant','replacement','final_answer')));
    const r = new CodexRolloutReader({sessionsDir:f.sessions,allowedWorkspaces:[f.allowed],deniedWorkspaces:[f.denied],includeSubagents:false,identityAnchors:()=>({[f.id]:{identity:trusted.identity}})});
    assert.deepEqual(r.discover(), []); assert.throws(()=>r.readPage(f.id), code('THREAD_NOT_FOUND'));
  }
});

test('read result redacts JSON, bare keys, authorization, JWT and sk credentials', () => {
  const samples = ['{"api_key":"artificial-json-secret"}', 'token=artificial-bare-secret', 'apiKey: artificial-api-secret',
    'Authorization: Bearer artificial-opaque-token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.syntheticSignature1234', 'sk-TESTONLY0123456789TESTONLY0123456789'];
  for (const text of samples) { const safe = scrubText(text); assert.notEqual(safe, text); assert.ok(safe.includes('[REDACTED]')); }
  const f = fixture(); f.write(f.meta, message('assistant', samples.join('\n'), 'final_answer'));
  const output = f.reader().readPage(f.id).items[0].text!;
  assert.equal(output.includes('artificial-'), false); assert.equal(output.includes('syntheticSignature'), false);
});

test('quoted redaction consumes escaped quotes and multiline credentials completely', () => {
  const input = '{"api_key":"first\\\"remaining-private-secret"}\nsecret=\'multi\nline-private-secret\'\nCookie: a=first-private; b=second-private';
  const safe = scrubText(input);
  assert.equal(safe.includes('remaining-private'), false); assert.equal(safe.includes('line-private'), false);
  assert.equal(safe.includes('second-private'), false); assert.ok(safe.includes('[REDACTED]'));
});

test('empty allow list and invalid budgets fail closed', () => {
  const f = fixture(); f.write(f.meta);
  assert.throws(() => new CodexRolloutReader({ sessionsDir: f.sessions, allowedWorkspaces: [], deniedWorkspaces: [], includeSubagents: false }), code('NO_ALLOWED_WORKSPACE'));
  assert.throws(() => f.reader().readPage(f.id, { maxChars: 0 }), code('INVALID_BUDGET'));
});
