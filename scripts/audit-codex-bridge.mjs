#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTECTED = 'F:\\AI\\对话备份';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (child, root) => {
  const rel = relative(fold(root), fold(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const clean = value => String(value ?? '').replace(/(["']?(?:api[_-]?key|token|authorization|password|secret)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*\2/gi, '$1$2[REDACTED]$2')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, 'Bearer [REDACTED]')
  .replace(/(\b(?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)(?!["']|Bearer\b)[^\s,;\r\n]+/gi, '$1[REDACTED]')
  .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
  .replace(/[\r\n]+/g, ' ').slice(0, 1000);

function rejectProtected(path) {
  if (inside(resolve(path), resolve(PROTECTED))) throw new Error('The protected conversation-backup directory is not an audit destination or source.');
}
function safeDataDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('--data requires an absolute bridge data directory.');
  rejectProtected(path);
  const resolved = realpathSync.native(path);
  rejectProtected(resolved);
  if (!statSync(resolved).isDirectory()) throw new Error('--data must be a directory.');
  return resolved;
}
function safeRead(root, name) {
  const path = join(root, name);
  if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic-link audit files are not accepted.');
  const canonical = realpathSync.native(path);
  rejectProtected(canonical);
  if (!inside(canonical, root)) throw new Error('An audit file is outside the specified bridge data directory.');
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('An audit file is not a regular file or exceeds the 64 MiB inspection limit.');
  return readFileSync(canonical, 'utf8');
}

/** Inspect only checkpoint and metadata journals in the explicitly supplied directory. */
export function auditBridge({ dataDir, hours = 24, now = new Date().toISOString() }) {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) throw new Error('--hours must be greater than zero and no more than 8760.');
  if (!iso(now)) throw new Error('--now must be an ISO timestamp with an explicit timezone.');
  const root = safeDataDir(dataDir), toMs = Date.parse(now), fromMs = toMs - hours * 3600000;
  const from = new Date(fromMs).toISOString(), to = new Date(toMs).toISOString();
  const records = [], issues = [], files = [], priorRecords = new Map();
  let invalidLines = 0, ignoredRecords = 0, futureRecords = 0, checkpoint = null;
  if (existsSync(join(root, 'checkpoint.json'))) {
    try {
      const parsed = JSON.parse(safeRead(root, 'checkpoint.json'));
      if (!parsed || parsed.version !== 1 || !parsed.threads || typeof parsed.threads !== 'object' || Array.isArray(parsed.threads)) throw new Error('Invalid checkpoint version or thread map.');
      checkpoint = parsed;
    } catch (error) { issues.push({ code: 'checkpoint_invalid', message: clean(error.message) }); }
  } else issues.push({ code: 'checkpoint_missing', message: 'No bridge checkpoint is available.' });

  for (const name of readdirSync(root).filter(name => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    try {
      const text = safeRead(root, name); files.push(name);
      const lines = text.split('\n');
      for (let line = 0; line < lines.length; line++) {
        if (!lines[line].trim()) continue;
        try {
          const record = JSON.parse(lines[line]);
          if (!record || record.source !== 'codexbridge' || typeof record.kind !== 'string' || !iso(record.ts)) { ignoredRecords++; continue; }
          const ms = Date.parse(record.ts);
          if (ms > toMs) { futureRecords++; continue; }
          if (ms >= fromMs) records.push({ ...record, ms });
          else if (['start', 'poll', 'source_warning'].includes(record.kind) && (!priorRecords.has(record.kind) || priorRecords.get(record.kind).ms < ms)) {
            // Older journals establish the watch settings and window boundary;
            // retain no old history beyond these three metadata anchors.
            priorRecords.set(record.kind, { ...record, ms });
          }
        } catch { invalidLines++; if (issues.filter(i => i.code === 'journal_invalid_line').length < 20) issues.push({ code: 'journal_invalid_line', file: name, line: line + 1, message: 'Invalid JSONL metadata record; raw contents were omitted.' }); }
      }
    } catch (error) { issues.push({ code: 'journal_unavailable', file: name, message: clean(error.message) }); }
  }
  records.push(...priorRecords.values()); records.sort((a, b) => a.ms - b.ms);
  const windowRecords = records.filter(r => r.ms >= fromMs);
  const polls = windowRecords.filter(r => r.kind === 'poll');
  const allPolls = records.filter(r => r.kind === 'poll');
  const lastPoll = allPolls.at(-1);
  const lastStart = records.filter(r => r.kind === 'start').at(-1);
  const interval = typeof lastStart?.intervalSeconds === 'number' && lastStart.intervalSeconds >= 0 ? lastStart.intervalSeconds : 5;
  const staleAfterSeconds = Math.max(30, interval * 3);
  const currentGapSeconds = lastPoll ? Math.max(0, (toMs - lastPoll.ms) / 1000) : null;
  const heartbeatFromMs = Math.max(fromMs, records[0]?.ms ?? toMs);
  const heartbeatTimes = [heartbeatFromMs, ...polls.map(p => p.ms), toMs];
  const maxIntervalSeconds = heartbeatTimes.slice(1).reduce((max, t, i) => Math.max(max, (t - heartbeatTimes[i]) / 1000), 0);
  const missing = !lastPoll;
  const stale = interval > 0 && (missing || currentGapSeconds > staleAfterSeconds);
  const incompleteLogs = invalidLines > 0 || ignoredRecords > 0 || issues.some(i => ['journal_unavailable', 'checkpoint_invalid', 'checkpoint_missing'].includes(i.code));
  const completeWindow = !!records.length && records[0].ms <= fromMs && polls.length > 0 &&
    (polls[0].ms - fromMs) / 1000 <= staleAfterSeconds && !stale && !incompleteLogs;
  if (missing) issues.push({ code: 'heartbeat_missing', message: 'No completed poll heartbeat is present in the inspected journals.' });
  else if (stale) issues.push({ code: 'heartbeat_stale', message: `Latest completed poll is ${currentGapSeconds.toFixed(1)} seconds old.` });
  if (maxIntervalSeconds > staleAfterSeconds) issues.push({ code: 'heartbeat_gap', message: `Largest observed heartbeat gap in the requested window is ${maxIntervalSeconds.toFixed(1)} seconds.` });
  if (interval === 0) issues.push({ code: 'watch_disabled', message: 'The latest start record disables automatic polling.' });
  if (!completeWindow) issues.push({ code: 'window_incomplete', message: 'Evidence does not cover the full requested window; a 24-hour stability acceptance cannot be inferred.' });

  const deliveries = windowRecords.filter(r => r.kind === 'delivery');
  const uniqueDeliveries = [...new Map(deliveries.map((d, i) => [typeof d.deliveryId === 'string' ? d.deliveryId : `unidentified-record-${i}`, d])).values()];
  const failures = windowRecords.filter(r => r.kind === 'failure');
  const toolReads = windowRecords.filter(r => r.kind === 'tool_read');
  const warningRecords = windowRecords.filter(r => r.kind === 'source_warning');
  const currentWarningRecord = records.filter(r => r.kind === 'source_warning').at(-1);
  const priorWarningRecord = priorRecords.get('source_warning');
  const currentWarnings = Array.isArray(currentWarningRecord?.warnings) ? currentWarningRecord.warnings.map(clean).slice(0, 20) :
    Array.isArray(checkpoint?.discoveryWarnings) ? checkpoint.discoveryWarnings.map(clean).slice(0, 20) : [];
  const carriedWarnings = Array.isArray(priorWarningRecord?.warnings) && priorWarningRecord.warnings.length > 0;
  const windowHadWarnings = carriedWarnings || warningRecords.some(r => Array.isArray(r.warnings) && r.warnings.length > 0) || currentWarnings.length > 0;
  if (windowHadWarnings) issues.push({ code: 'source_coverage_warning', message: 'One or more source files were excluded from discovery. This is a source-coverage warning, separate from bridge delivery failures.' });
  const behind = polls.map(p => count(p.behindThreads));
  const pendingDeliveries = checkpoint?.pending && typeof checkpoint.pending === 'object' ? Object.keys(checkpoint.pending).length : 0;
  const latestBehindThreads = behind.at(-1) ?? null;
  const currentCheckpointFailure = checkpoint?.lastError && iso(checkpoint.lastError.at) &&
    (!iso(checkpoint.lastSuccessAt) || Date.parse(checkpoint.lastError.at) >= Date.parse(checkpoint.lastSuccessAt));
  if (pendingDeliveries) issues.push({ code: 'pending_delivery', message: `${pendingDeliveries} durable delivery intent(s) await acknowledgement.` });
  if (latestBehindThreads > 0) issues.push({ code: 'source_backlog', message: `${latestBehindThreads} source thread(s) were behind in the latest poll.` });
  if (currentCheckpointFailure) issues.push({ code: 'checkpoint_current_failure', message: clean(checkpoint.lastError.message) });
  const operationalFault = failures.length > 0 || toolReads.some(r => r.ok === false) || polls.some(p => count(p.failed) > 0) ||
    stale || missing || maxIntervalSeconds > staleAfterSeconds || incompleteLogs || pendingDeliveries > 0 || latestBehindThreads > 0 || currentCheckpointFailure;

  return {
    source: 'codexbridge-audit-v1', generatedAt: to, dataDir: root,
    window: { hours, from, to, complete: completeWindow, earliestAuditAt: records[0]?.ts ?? null, latestAuditAt: records.at(-1)?.ts ?? null,
      observedHours: records.length ? Math.min(hours, Math.max(0, (records.at(-1).ms - Math.max(fromMs, records[0].ms)) / 3600000)) : 0 },
    assessment: operationalFault ? 'needs_attention' : windowHadWarnings ? 'source_coverage_warning' : completeWindow ? 'healthy_observed_window' : 'insufficient_evidence',
    stabilityAccepted: false,
    totals: { starts: windowRecords.filter(r => r.kind === 'start').length, stops: windowRecords.filter(r => r.kind === 'stop').length,
      polls: polls.length, deliveryRecords: deliveries.length, deliveries: uniqueDeliveries.length, newDeliveries: deliveries.filter(r => r.recovered !== true).length,
      recoveredDeliveries: deliveries.filter(r => r.recovered === true).length, deliveredItems: uniqueDeliveries.reduce((n, d) => n + count(d.items), 0),
      reportedItemReceipts: deliveries.reduce((n, d) => n + count(d.items), 0),
      toolReadsSucceeded: toolReads.filter(r => r.ok === true).length, toolReadsFailed: toolReads.filter(r => r.ok === false).length,
      failures: failures.length, sourceWarningRecords: warningRecords.length, failedPolls: polls.filter(p => count(p.failed) > 0).length, pollFailures: polls.reduce((n, p) => n + count(p.failed), 0),
      scannedBytes: polls.reduce((n, p) => n + count(p.scannedBytes), 0), itemsRead: polls.reduce((n, p) => n + count(p.itemsRead), 0) },
    heartbeat: { enabled: interval > 0, expectedIntervalSeconds: interval, staleAfterSeconds, latestPollAt: lastPoll?.ts ?? null,
      currentGapSeconds, maxIntervalSeconds, observedFrom: new Date(heartbeatFromMs).toISOString(), missing, stale,
      maxPollElapsedMs: polls.reduce((max, p) => Math.max(max, count(p.elapsedMs)), 0) },
    backlog: { latestBehindThreads, maxBehindThreads: behind.reduce((max, n) => Math.max(max, n), 0), pendingDeliveries },
    checkpoint: checkpoint ? { version: checkpoint.version, updatedAt: iso(checkpoint.updatedAt) ? checkpoint.updatedAt : null,
      trackedThreads: Object.keys(checkpoint.threads).length, counters: Object.fromEntries(['pushedEvents', 'pushedItems', 'polls', 'failures'].map(k => [k, count(checkpoint[k])])),
      lastPollAt: iso(checkpoint.lastPollAt) ? checkpoint.lastPollAt : null, lastSuccessAt: iso(checkpoint.lastSuccessAt) ? checkpoint.lastSuccessAt : null,
      lastError: checkpoint.lastError ? { at: iso(checkpoint.lastError.at) ? checkpoint.lastError.at : null, message: clean(checkpoint.lastError.message) } : null } : null,
    recentFailures: windowRecords.filter(r => r.kind === 'failure' || r.kind === 'tool_read' && r.ok === false).slice(-20)
      .map(r => ({ ts: r.ts, kind: r.kind, tool: r.kind === 'tool_read' ? clean(r.tool) : null, threadId: typeof r.threadId === 'string' ? r.threadId : null, message: clean(r.message) })),
    sourceCoverage: { currentWarnings, windowHadWarnings, latestWarningAt: currentWarningRecord?.ts ?? null },
    windowWarnings: [...(carriedWarnings ? [{ ...priorWarningRecord, carriedIntoWindow: true }] : []), ...warningRecords].slice(-20)
      .map(r => ({ ts: r.ts, carriedIntoWindow: r.carriedIntoWindow === true, warnings: Array.isArray(r.warnings) ? r.warnings.map(clean).slice(0, 20) : [] })),
    journals: { files, recordsInWindow: windowRecords.length, ignoredRecords, invalidLines, futureRecords },
    issues,
    evidenceLimits: ['This report reads bridge checkpoint and metadata journals only; it does not inspect Codex conversation bodies.',
      'A clean metadata window does not prove task quality, memory relevance, source completeness, or successful Cortico reasoning.',
      'stabilityAccepted remains false: runtime acceptance requires source and delivery reconciliation in addition to heartbeat statistics.'],
  };
}

function saveReport(path, report) {
  if (!isAbsolute(path)) throw new Error('--out requires an absolute report path.');
  rejectProtected(path);
  let ancestor = resolve(path, '..');
  while (!existsSync(ancestor)) { const parent = resolve(ancestor, '..'); if (parent === ancestor) throw new Error('Report output has no existing ancestor.'); ancestor = parent; }
  rejectProtected(realpathSync.native(ancestor));
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symbolic-link report outputs are not accepted.');
    rejectProtected(realpathSync.native(path));
  }
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
export function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--hours24') { values['--hours'] = '24'; continue; }
    if (!['--data', '--hours', '--now', '--out'].includes(key) || values[key] !== undefined || !argv[i + 1]) throw new Error('Usage: node audit-codex-bridge.mjs --data <absolute directory> [--hours 24] [--now ISO] [--out <absolute file>]');
    values[key] = argv[++i];
  }
  if (!values['--data']) throw new Error('--data is required; the tool does not discover or scan other directories.');
  if (values['--now'] && !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(values['--now'])) throw new Error('--now must be an ISO timestamp with an explicit timezone.');
  const report = auditBridge({ dataDir: values['--data'], hours: values['--hours'] === undefined ? 24 : Number(values['--hours']), now: values['--now'] });
  if (values['--out']) saveReport(values['--out'], report);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
  catch (error) { process.stderr.write(clean(error.message) + '\n'); process.exitCode = 2; }
}
