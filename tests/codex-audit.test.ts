import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const base = join(process.cwd(), 'scratch', 'codex-audit-tests'); mkdirSync(base, { recursive: true });
const script = join(process.cwd(), 'scripts', 'audit-codex-bridge.mjs');
const now = '2026-10-05T12:00:00.000Z';
const ms = Date.parse(now), stamp = (seconds: number) => new Date(ms + seconds * 1000).toISOString();
const row = (seconds: number, kind: string, extra: Record<string, unknown> = {}) => ({ ts: stamp(seconds), source: 'codexbridge', kind, ...extra });
function fixture(records: unknown[], checkpointExtra: Record<string, unknown> = {}) {
  const data = mkdtempSync(join(base, 'run-'));
  writeFileSync(join(data, 'checkpoint.json'), JSON.stringify({ version: 1, threads: {}, updatedAt: now,
    pushedEvents: 0, pushedItems: 0, polls: 1, failures: 0, lastPollAt: stamp(-5), lastSuccessAt: stamp(-5), lastError: null, ...checkpointExtra }));
  writeFileSync(join(data, 'audit-2026-10-05.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const run = (args: string[] = []) => spawnSync(process.execPath, [script, '--data', data, '--now', now, ...args], { encoding: 'utf8' });
  const report = (args: string[] = []) => { const r = run(args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  return { data, run, report };
}

test('fresh installation exposes incomplete 24-hour evidence and cannot pass stability acceptance', () => {
  const f = fixture([row(-10, 'start', { intervalSeconds: 5 }), row(-10, 'poll', { behindThreads: 0 }), row(-5, 'poll', { behindThreads: 0 })]);
  const r = f.report(); assert.equal(r.window.complete, false); assert.equal(r.stabilityAccepted, false);
  assert.equal(r.assessment, 'insufficient_evidence'); assert.ok(r.issues.some((i: { code: string }) => i.code === 'window_incomplete')); assert.equal(r.totals.polls, 2);
});
test('complete clean heartbeat evidence is healthy only for its observed metadata window', () => {
  const records = [row(-86405, 'start', { intervalSeconds: 3600 })];
  for (let s = -86400; s <= 0; s += 3600) records.push(row(s, 'poll', { behindThreads: 0, elapsedMs: 7, scannedBytes: 100 }));
  const r = fixture(records).report(['--hours24']); assert.equal(r.window.complete, true); assert.equal(r.assessment, 'healthy_observed_window');
  assert.equal(r.stabilityAccepted, false); assert.equal(r.heartbeat.maxIntervalSeconds, 3600); assert.equal(r.totals.scannedBytes, 2500);
});
test('missing and stale heartbeats are detected independently of checkpoint success metadata', () => {
  const missing = fixture([row(-86405, 'start', { intervalSeconds: 5 })]).report(); assert.equal(missing.heartbeat.missing, true); assert.equal(missing.assessment, 'needs_attention');
  const stale = fixture([row(-86405, 'start', { intervalSeconds: 5 }), row(-3600, 'poll')]).report();
  assert.equal(stale.heartbeat.stale, true); assert.equal(stale.heartbeat.currentGapSeconds, 3600); assert.equal(stale.assessment, 'needs_attention');
});
test('delivery recovery, tools, failures, backlog and checkpoint intent counts remain separate', () => {
  const records = [row(-10, 'start', { intervalSeconds: 5 }), row(-8, 'delivery', { items: 2, recovered: false }), row(-7, 'delivery', { items: 3, recovered: true }),
    row(-6, 'tool_read', { ok: true }), row(-5, 'tool_read', { ok: false }), row(-4, 'failure', { message: 'redacted write failure' }),
    row(-3, 'poll', { behindThreads: 2, failed: 1, scannedBytes: 999, itemsRead: 5, elapsedMs: 10 }), row(-2, 'stop')];
  const r = fixture(records, { pending: { intent: { from: 0, to: 1 } }, lastError: { at: stamp(-4), message: 'redacted write failure' }, lastSuccessAt: stamp(-10) }).report();
  assert.deepEqual([r.totals.deliveries, r.totals.newDeliveries, r.totals.recoveredDeliveries, r.totals.deliveredItems], [2, 1, 1, 5]);
  assert.deepEqual([r.totals.toolReadsSucceeded, r.totals.toolReadsFailed, r.totals.failures, r.totals.failedPolls], [1, 1, 1, 1]);
  assert.equal(r.backlog.latestBehindThreads, 2); assert.equal(r.backlog.pendingDeliveries, 1); assert.equal(r.totals.stops, 1); assert.equal(r.assessment, 'needs_attention');
});
test('failure summaries are bounded and redact credentials without exporting journal bodies', () => {
  const records = [row(-30, 'start', { intervalSeconds: 5 })];
  for (let n = 25; n > 0; n--) records.push(row(-n, 'failure', { message: `token=super-secret-${n} Bearer eyJabcdef.abcdefgh.ijklmnop sk-TESTONLY0123456789TESTONLY0123456789`, text: 'PRIVATE CONVERSATION BODY' }));
  records.push(row(-1, 'poll'));
  const f = fixture(records), r = f.report(); assert.equal(r.recentFailures.length, 20); assert.equal(r.totals.failures, 25);
  const json = JSON.stringify(r); assert.doesNotMatch(json, /super-secret|eyJabcdef|sk-TESTONLY0123456789TESTONLY0123456789|PRIVATE CONVERSATION BODY/);
  assert.match(json, /REDACTED/);
});
test('bad and torn metadata lines make coverage incomplete and retain only safe diagnostics', () => {
  const f = fixture([row(-86405, 'start', { intervalSeconds: 5 }), row(-5, 'poll')]);
  writeFileSync(join(f.data, 'audit-2026-10-05.jsonl'), JSON.stringify(row(-5, 'poll')) + '\n{"secret":"UNFINISHED');
  const r = f.report(); assert.equal(r.journals.invalidLines, 1); assert.equal(r.window.complete, false); assert.equal(r.assessment, 'needs_attention');
  assert.doesNotMatch(JSON.stringify(r), /UNFINISHED/);
});
test('CLI requires an absolute explicit data path, rejects protected paths before access, and can save reports', () => {
  const absent = spawnSync(process.execPath, [script], { encoding: 'utf8' }); assert.equal(absent.status, 2); assert.match(absent.stderr, /--data is required/);
  const relative = spawnSync(process.execPath, [script, '--data', '.'], { encoding: 'utf8' }); assert.equal(relative.status, 2); assert.match(relative.stderr, /absolute/);
  const denied = join(base, 'protected-fixture');
  const protectedPath = spawnSync(process.execPath, [script, '--data', denied], { encoding: 'utf8', env: { ...process.env, CORTICO_BRIDGE_PROTECTED_DIR: denied } }); assert.equal(protectedPath.status, 2); assert.match(protectedPath.stderr, /protected/);
  const f = fixture([row(-5, 'poll')]), out = join(f.data, 'report.json'); const r = f.report(['--out', out]);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).source, r.source); assert.ok(!r.journals.files.includes('report.json'));
});
test('records outside the requested window and future entries do not inflate counters', () => {
  const f = fixture([row(-86405, 'start'), row(-86401, 'failure', { message: 'historical' }), row(-1, 'poll'), row(1, 'delivery', { items: 999 })]);
  const r = f.report(); assert.equal(r.totals.failures, 0); assert.equal(r.totals.deliveries, 0); assert.equal(r.journals.futureRecords, 1);
});
test('discovery coverage warnings stay separate from bridge failures and track warning clearance', () => {
  const f = fixture([row(-10, 'start', { intervalSeconds: 5 }), row(-9, 'source_warning', { warnings: ['Ambiguous duplicate thread 123.'] }), row(-5, 'poll')]);
  const r = f.report(); assert.equal(r.totals.sourceWarningRecords, 1); assert.equal(r.totals.failures, 0);
  assert.equal(r.assessment, 'source_coverage_warning'); assert.equal(r.sourceCoverage.currentWarnings.length, 1); assert.equal(r.windowWarnings.length, 1);
  const cleared = fixture([row(-10, 'start', { intervalSeconds: 5 }), row(-9, 'source_warning', { warnings: ['Ambiguous duplicate thread 123.'] }), row(-7, 'source_warning', { warnings: [] }), row(-5, 'poll')]).report();
  assert.equal(cleared.sourceCoverage.currentWarnings.length, 0); assert.equal(cleared.sourceCoverage.windowHadWarnings, true);
  assert.equal(cleared.totals.failures, 0); assert.equal(cleared.totals.sourceWarningRecords, 2);
});
test('receipt recovery does not double-count uniquely delivered events or source items', () => {
  const r = fixture([row(-10, 'start', { intervalSeconds: 5 }), row(-8, 'delivery', { deliveryId: 'same-delivery', recovered: false, items: 3 }),
    row(-7, 'delivery', { deliveryId: 'same-delivery', recovered: true, items: 3 }), row(-5, 'poll')]).report();
  assert.equal(r.totals.deliveryRecords, 2); assert.equal(r.totals.deliveries, 1); assert.equal(r.totals.deliveredItems, 3);
  assert.equal(r.totals.reportedItemReceipts, 6); assert.equal(r.totals.recoveredDeliveries, 1);
});
test('a pre-window source warning remains part of coverage evidence even when cleared during the window', () => {
  const r = fixture([row(-86500, 'source_warning', { warnings: ['Duplicate source excluded.'] }), row(-5, 'source_warning', { warnings: [] }), row(-1, 'poll')]).report();
  assert.equal(r.sourceCoverage.currentWarnings.length, 0); assert.equal(r.sourceCoverage.windowHadWarnings, true);
  assert.equal(r.windowWarnings[0].carriedIntoWindow, true); assert.equal(r.totals.sourceWarningRecords, 1); assert.equal(r.totals.failures, 0);
});
