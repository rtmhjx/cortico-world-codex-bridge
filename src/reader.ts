import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scrubText, scrubTextPrefix } from './scrub.ts';
import { FrameError, frames, type Frame, type ProjectedRow } from './framer.ts';

export interface ReaderOptions {
  sessionsDir: string;
  allowedWorkspaces: string[];
  deniedWorkspaces: string[];
  includeSubagents: boolean;
  /** Only persisted bridge cursors may disambiguate an existing thread. */
  identityAnchors?: () => Readonly<Record<string, { identity: string }>>;
}
export interface ThreadInfo {
  id: string;
  cwd: string;
  file: string;
  mtimeMs: number;
  size: number;
  identity: string;
  /** Last complete LF boundary, suitable for starting a new live watch. */
  baselineOffset: number;
  source: string;
}
export interface CodexItem {
  id: string;
  cwd: string;
  offset: number;
  endOffset: number;
  ts: string;
  kind: 'message' | 'lifecycle' | 'signal';
  role?: 'user' | 'assistant';
  phase?: 'user' | 'commentary' | 'final_answer';
  text?: string;
  turnId?: string;
  state?: 'started' | 'completed' | 'failed' | 'aborted';
  /** Exact native error code; never inferred from error prose. */
  reasonCode?: string;
  truncated?: boolean;
  importantReason?: 'request_user_input' | 'approval_required' | 'waiting_user' | 'quota' | 'rate_limit' | 'credits';
}
export interface ReadPage {
  items: CodexItem[];
  nextOffset: number;
  hasMore: boolean;
  tornTail: boolean;
  bytesScanned: number;
  truncated: boolean;
  contextBytesScanned: number;
  budgetExceeded: boolean;
  budgetOverrunBytes:number;
}
export interface ReadPageOptions { offset?: number; limit?: number; maxBytes?: number; maxChars?: number; stopOffset?:number }
export class CodexReaderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'CodexReaderError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = ProjectedRow;
type Line = Frame;
type Context = { cwd: string; allowed: boolean; turnId?: string };
const fail = (code: string, message: string): never => { throw new CodexReaderError(code, message); };
const folded = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
function within(child: string, root: string): boolean {
  const rel = relative(folded(root), folded(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function canonical(p: string): string {
  if (!isAbsolute(p)) return fail('INVALID_PATH', 'Source and workspace paths must be absolute.');
  return realpathSync.native(resolve(p));
}
function rootPaths(paths: string[]): string[] {
  return paths.map(p => {
    if (!isAbsolute(p)) return fail('INVALID_PATH', 'Workspace paths must be absolute.');
    try { return canonical(p); } catch { return resolve(p); }
  });
}
function deniedRoots(paths: string[]): string[] {
  // Retain lexical names as well as resolved targets: changing a junction must
  // not turn an explicitly protected pathname into an allowed workspace.
  return [...new Set([...paths.map(p => {
    if (!isAbsolute(p)) return fail('INVALID_PATH', 'Workspace paths must be absolute.');
    return resolve(p);
  }), ...rootPaths(paths)])];
}
function parseLine(line: Line): Row {
  return line.row;
}
function* lines(fd:number,start:number,end:number,options:Parameters<typeof frames>[3]):Generator<Line> {
  try { yield* frames(fd,start,end,options); }
  catch(error) { if(error instanceof FrameError)return fail(error.code,error.message);throw error; }
}
function baseline(fd: number, size: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const n = readSync(fd, chunk, 0, end - start, start);
    const lf = chunk.subarray(0, n).lastIndexOf(10);
    if (lf !== -1) return start + lf + 1;
    end = start;
  }
  return 0;
}
function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return fail('INVALID_BUDGET', `Invalid ${name}.`);
  return n;
}

function object(value: unknown): Record<string, any> | null {
  if(typeof value==='string') { try { value=JSON.parse(value); } catch { return null; } }
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
}
function publicSignal(p:Record<string,any>,type:string):Pick<CodexItem,'importantReason'|'text'>|null {
  const name=typeof p.name==='string'?p.name.split('.').at(-1):'';
  const args=object(p.arguments??p.input)??{};
  let importantReason:CodexItem['importantReason'];
  if(['request_user_input','request_user_input_async'].includes(name??'')||['request_user_input','request_user_input_requested','user_input_requested'].includes(p.type))importantReason='request_user_input';
  else if(['request_approval','request_user_approval','approval_request'].includes(name??'')||['approval_required','approval_request','waiting_for_approval'].includes(p.type)||name==='exec_command'&&args.sandbox_permissions==='require_escalated')importantReason='approval_required';
  else if(p.type==='waiting_for_user'||['task_status','turn_status','status'].includes(p.type)&&['waiting_for_user','awaiting_user_input','waiting_for_approval'].includes(p.status))importantReason='waiting_user';
  // Inspect only explicit error records or structured error outputs. Ordinary
  // tool output, message text and hidden analysis never become error signals.
  const errorRecord=type==='event_msg'&&['error','warning','task_failed','task_error','turn_error','task_complete'].includes(p.type);
  const output=type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)?object(p.output):null;
  const error=object(p.error)??object(output?.error);
  const enumInfo=object(p.codex_error_info);
  const code=String(error?.code??error?.type??(errorRecord?p.code??p.error_code??(enumInfo?Object.keys(enumInfo)[0]:p.codex_error_info):'')??'').replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase().replace(/[^a-z0-9]+/g,'_');
  if(/^(rate_limit|rate_limit_exceeded|rate_limit_reached)$/.test(code))importantReason='rate_limit';
  else if(/^(credits_exhausted|insufficient_credits|credit_balance_exhausted)$/.test(code))importantReason='credits';
  else if(/^(quota_exceeded|insufficient_quota|usage_limit|usage_limit_reached|usage_limit_exceeded|token_limit_reached)$/.test(code))importantReason='quota';
  if(!importantReason&&errorRecord) {
    const text=typeof p.message==='string'?p.message:typeof p.error==='string'?p.error:'';
    if(/\brate[ _-]limit(?:ed|\s+(?:exceeded|reached))?\b/i.test(text))importantReason='rate_limit';
    else if(/\b(?:insufficient|not enough|exhausted)\s+credits?\b|\bcredits?\s+(?:exhausted|insufficient)\b/i.test(text))importantReason='credits';
    else if(/\b(?:quota\s+(?:exceeded|exhausted)|insufficient[ _]quota|usage\s+limit\s+(?:reached|exceeded))\b|额度不足|额度已用尽|达到.{0,12}额度/i.test(text))importantReason='quota';
  }
  if(!importantReason)return null;
  const questions=Array.isArray(args.questions)?args.questions:Array.isArray(p.questions)?p.questions:[];
  const publicText=questions.flatMap((q:any)=>typeof q?.question==='string'?[q.question,...(Array.isArray(q.options)?q.options.flatMap((o:any)=>typeof o?.label==='string'?[`选项：${o.label}${typeof o.description==='string'?`；${o.description}`:''}`]:[]):[])]:[]).join('\n')||
    (typeof args.justification==='string'?args.justification:typeof p.message==='string'?p.message:'');
  return {importantReason,text:scrubText(publicText||`Codex 结构化信号：${importantReason}`)};
}

/** Only first-party public messages are exported. Source files are never written. */
export class CodexRolloutReader {
  readonly diagnostics: string[] = [];
  private root = '';
  private allowed: string[] = [];
  private denied: string[] = [];
  private index = new Map<string, ThreadInfo>();
  private metadataCache = new Map<string, { signature: string; info: ThreadInfo }>();
  constructor(private readonly options: ReaderOptions) {
    try { this.root = canonical(options.sessionsDir); }
    catch { return fail('SOURCE_NOT_FOUND', 'The configured Codex sessions directory is unavailable.'); }
    this.allowed = rootPaths(options.allowedWorkspaces);
    this.denied = deniedRoots(options.deniedWorkspaces);
    if (!this.allowed.length) fail('NO_ALLOWED_WORKSPACE', 'At least one explicit allowed workspace is required.');
    if (this.denied.some(p => within(this.root, p) || within(resolve(options.sessionsDir), p))) fail('SOURCE_DENIED', 'The source directory is protected.');
  }
  private permitted(cwd: unknown): cwd is string {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
    let path: string;
    try { path = canonical(cwd); } catch { return false; }
    return !this.denied.some(p => within(path, p) || within(resolve(cwd), p))
      && this.allowed.some(p => within(path, p));
  }
  private sourcePath(file: string): string {
    const path = canonical(file);
    if (!within(path, this.root) || this.denied.some(p => within(path, p))) return fail('SOURCE_DENIED', 'Source file is outside the permitted sessions directory.');
    if (lstatSync(file).isSymbolicLink()) return fail('SOURCE_DENIED', 'Symbolic-link source files are not accepted.');
    return path;
  }
  private info(file: string): ThreadInfo | null {
    const path = this.sourcePath(file), fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      const signature = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const cached = this.metadataCache.get(path);
      // Keep realpath/source validation and workspace permission rechecks even
      // when unchanged files avoid rereading header and tail on each poll.
      if (cached?.signature === signature && this.permitted(cached.info.cwd)) return { ...cached.info };
      const info = this.infoFromHandle(path, fd);
      if (info) this.metadataCache.set(path, { signature, info: { ...info } });
      else this.metadataCache.delete(path);
      return info;
    }
    finally { closeSync(fd); }
  }
  private infoFromHandle(path: string, fd: number): ThreadInfo | null {
      const stat = fstatSync(fd);
      const first = lines(fd,0,baseline(fd,stat.size),{maxChars:0,identityPrefix:`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:`}).next().value as Line | undefined;
      if (!first) return null;
      const row = parseLine(first), meta = row.payload;
      if (row.type !== 'session_meta' || !meta || typeof meta.id !== 'string' || !UUID.test(meta.id)) return null;
      if (!this.options.includeSubagents && (meta.agent_path || meta.parent_thread_id || (typeof meta.source === 'object' && meta.source?.subagent))) return null;
      if (!this.permitted(meta.cwd)) return null;
      const identity = first.identity!;
      return { id: meta.id.toLowerCase(), cwd: meta.cwd, file: path, mtimeMs: stat.mtimeMs, size: stat.size,
        identity, baselineOffset: baseline(fd, stat.size), source: typeof meta.source === 'string' ? meta.source : 'subagent' };
  }
  discover(): ThreadInfo[] {
    this.diagnostics.length = 0;
    const found = new Map<string, ThreadInfo>();
    const candidates = new Map<string, ThreadInfo[]>();
    const anchors = this.options.identityAnchors?.() ?? {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
          try { walk(this.sourcePath(file)); }
          catch (e) { this.diagnostics.push(e instanceof CodexReaderError ? `${e.code}: ${e.message}` : 'A source subdirectory could not be inspected.'); }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        try {
          const info = this.info(file);
          if (!info) continue;
          const group = candidates.get(info.id) ?? [];
          group.push(info); candidates.set(info.id, group);
        } catch (e) { this.diagnostics.push(e instanceof CodexReaderError ? `${e.code}: ${e.message}` : 'A source file could not be inspected.'); }
      }
    };
    walk(this.root);
    for (const [id, group] of candidates) {
      const anchor = anchors[id]?.identity;
      if (anchor !== undefined) {
        const matches = group.filter(info => info.identity === anchor);
        // Even a sole remaining copy must not replace the persisted source.
        // Multiple matching paths (including hard links) remain ambiguous.
        if (matches.length === 1) {
          found.set(id, matches[0]);
          if (group.length > 1) this.diagnostics.push(`Duplicate thread ${id}: retained the checkpoint identity; quarantined ${group.length - 1} other source(s).`);
        } else this.diagnostics.push(`Tracked thread ${id}: checkpoint identity matched ${matches.length} of ${group.length} permitted source(s); all candidates were rejected.`);
      } else if (group.length === 1) found.set(id, group[0]);
      else this.diagnostics.push(`Ambiguous duplicate thread ${id}: ${group.length} permitted sources and no checkpoint identity; all candidates were rejected.`);
    }
    this.index = found;
    const files = new Set([...candidates.values()].flatMap(group => group.map(x => x.file)));
    for (const file of this.metadataCache.keys()) if (!files.has(file)) this.metadataCache.delete(file);
    return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  }
  private updateContext(row: Row, ctx: Context): void {
    if (row.type !== 'turn_context') return;
    const p = row.payload ?? {};
    ctx.cwd = typeof p.cwd === 'string' ? p.cwd : '';
    ctx.allowed = this.permitted(ctx.cwd);
    ctx.turnId = typeof p.turn_id === 'string' ? p.turn_id : undefined;
  }
  private item(row: Row, line: Line, threadId: string, ctx: Context): CodexItem | null {
    if (!ctx.allowed) return null;
    const p = row.payload ?? {};
    const common = { id: `${threadId}:${line.offset}`, cwd: ctx.cwd, offset: line.offset, endOffset: line.endOffset,
      ts: typeof row.timestamp === 'string' ? row.timestamp : '', turnId: typeof p.turn_id === 'string' ? p.turn_id : ctx.turnId };
    // Native lifecycle wins over the older human-notification prose classifier.
    // A quota-like sentence alone must never become a machine quota assertion.
    if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted','task_aborted','task_failed','task_error','turn_error'].includes(p.type)) {
      const code = p.error && typeof p.error === 'object' ? p.error.code : undefined;
      const reasonCode = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(code) ? code : '';
      return { ...common, kind: 'lifecycle', state: p.type === 'task_started' ? 'started' : ['turn_aborted','task_aborted'].includes(p.type) ? 'aborted' : ['task_failed','task_error','turn_error'].includes(p.type)||p.error||p.status==='failed' ? 'failed' : 'completed', ...(reasonCode ? {reasonCode} : {}) };
    }
    if(row.type==='event_msg'||row.type==='response_item'&&['function_call','custom_tool_call','function_call_output','custom_tool_call_output'].includes(p.type)) {
      const signal=publicSignal(p,row.type!);
      if(signal)return {...common,kind:'signal',...signal,text:scrubTextPrefix(signal.text??'',!!row.projectionTruncated),truncated:!!row.projectionTruncated};
      if(row.type==='event_msg'&&['error','warning'].includes(p.type)&&row.projectionTruncated&&(typeof p.message==='string'||typeof p.error==='string'))return fail('PROJECTION_LIMIT',`An oversized error message cannot be safely classified at byte ${line.offset}; source position was retained.`);
    }
    if (row.type !== 'response_item' || p.type !== 'message' || !['user', 'assistant'].includes(p.role)) return null;
    const phase = p.phase ?? p.channel;
    if (p.role === 'assistant' && !['commentary', 'final_answer', 'final'].includes(phase)) return null;
    const metadata = p.internal_chat_message_metadata_passthrough ?? {};
    const kinds = metadata.content_item_kinds;
    if (!Array.isArray(p.content)) return null;
    if (p.role === 'user' && Array.isArray(kinds) && (row.projectionCounts?.contentKinds??kinds.length)!==(row.projectionCounts?.content??p.content.length)) return null;
    const pieces: string[] = [];
    for (let i = 0; i < p.content.length; i++) {
      const block = p.content[i];
      if (!block || typeof block.text !== 'string' || block.type !== (p.role === 'user' ? 'input_text' : 'output_text')) continue;
      if (p.role === 'user' && Array.isArray(kinds) && kinds[i] !== 'user.text') continue;
      const text = block.text;
      if (p.role === 'user' && /^\s*<(environment_context|recommended_plugins|external_codex_apps_open_page|skills_instructions|permissions_instructions|app-context|INSTRUCTIONS)\b[\s\S]*<\/\1>\s*$/i.test(text)) continue;
      if (p.role === 'user' && row.projectionTruncated && /^\s*<(environment_context|recommended_plugins|external_codex_apps_open_page|skills_instructions|permissions_instructions|app-context|INSTRUCTIONS)\b/i.test(text)) continue;
      if (p.role === 'user' && /^\s*#\s*AGENTS\.md instructions\b/i.test(text)) continue;
      pieces.push(text);
    }
    if (!pieces.length) {
      if(p.role==='user')return null;
      return {...common,kind:'message',role:'assistant',phase:phase==='commentary'?'commentary':'final_answer',text:'[非文本或有界投影之外的公开内容未导出；按源位置核对]',truncated:true};
    }
    return { ...common, turnId: typeof metadata.turn_id === 'string' ? metadata.turn_id : common.turnId,
      kind: 'message', role: p.role, phase: p.role === 'user' ? 'user' : phase === 'commentary' ? 'commentary' : 'final_answer', text: scrubTextPrefix(pieces.join('\n'),!!row.projectionTruncated),truncated:!!row.projectionTruncated };
  }
  readPage(threadId: string, options: ReadPageOptions = {}): ReadPage {
    if (!UUID.test(threadId)) return fail('INVALID_THREAD_ID', 'Thread ID must be a UUID.');
    const id = threadId.toLowerCase();
    const anchor = this.options.identityAnchors?.()[id]?.identity;
    if (!this.index.has(id) || anchor !== undefined && this.index.get(id)!.identity !== anchor) this.discover();
    const stored = this.index.get(id);
    if (!stored) return fail('THREAD_NOT_FOUND', 'Thread is unavailable or outside the permitted workspaces.');
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return fail('INVALID_OFFSET', 'Invalid source byte offset.');
    const limit = bounded(options.limit, 20, 1000, 'limit');
    const maxBytes = bounded(options.maxBytes, 2 * 1024 * 1024, 32 * 1024 * 1024, 'maxBytes');
    const maxChars = bounded(options.maxChars, 16000, 1024 * 1024, 'maxChars');
    const path = this.sourcePath(stored.file), fd = openSync(path, 'r');
    const result: ReadPage = { items: [], nextOffset: offset, hasMore: false, tornTail: false, bytesScanned: 0, truncated: false,contextBytesScanned:0,budgetExceeded:false,budgetOverrunBytes:0 };
    try {
      // Identity, snapshot length, initial cwd and public records come from the
      // same open handle, so a pathname replacement between opens cannot leak.
      const fresh = this.infoFromHandle(path, fd);
      if (!fresh || fresh.identity !== stored.identity) return fail('SOURCE_CHANGED', 'Source identity changed; rediscover before reading.');
      if (offset > fresh.size) return fail('INVALID_OFFSET', 'Invalid source byte offset.');
      if (offset > 0) {
        const previous = Buffer.alloc(1); readSync(fd, previous, 0, 1, offset - 1);
        if (previous[0] !== 10) return fail('INVALID_OFFSET', 'Offset must follow a complete JSONL line.');
      }
      const ctx: Context = { cwd: fresh.cwd, allowed: this.permitted(fresh.cwd) };
      const contextScan={bytesScanned:0,budgetExceeded:false};
      for (const line of lines(fd,0,offset,{maxChars:0,contextOnly:true,scan:contextScan}))this.updateContext(parseLine(line),ctx);
      result.contextBytesScanned=contextScan.bytesScanned;
      const stop=options.stopOffset??fresh.baselineOffset;
      if(!Number.isSafeInteger(stop)||stop<offset||stop>fresh.baselineOffset)return fail('INVALID_OFFSET','Invalid fixed source boundary.');
      if(stop>0) { const previous=Buffer.alloc(1);readSync(fd,previous,0,1,stop-1);if(previous[0]!==10)return fail('INVALID_OFFSET','Fixed source boundary must follow a complete JSONL line.'); }
      const end=Math.min(stop,offset+maxBytes),scan={bytesScanned:0,budgetExceeded:false};
      let chars = 0;
      for (const line of lines(fd,offset,stop,{softEnd:end,maxChars,scan})) {
        const row = parseLine(line);
        this.updateContext(row, ctx);
        const item = this.item(row, line, id, ctx);
        if (item) {
          if (result.items.length >= limit || (item.text !== undefined && chars >= maxChars)) { result.truncated = true; break; }
          if (item.text !== undefined) {
            const remaining = maxChars - chars;
            if (item.text.length > remaining) { item.text = item.text.slice(0, remaining); item.truncated = true; result.truncated = true; }
            chars += item.text.length;
          }
          result.items.push(item);
        }
        result.nextOffset = line.endOffset;
        if(item?.truncated||result.items.length>=limit)break;
      }
      result.bytesScanned=scan.bytesScanned;result.budgetExceeded=scan.budgetExceeded;result.budgetOverrunBytes=Math.max(0,scan.bytesScanned-maxBytes);
      result.tornTail = fresh.baselineOffset < fresh.size && result.nextOffset >= fresh.baselineOffset;
      result.hasMore = result.nextOffset < fresh.baselineOffset;
      if(end<fresh.baselineOffset||scan.budgetExceeded||result.items.some(i=>i.truncated))result.truncated=true;
      return result;
    } finally { closeSync(fd); }
  }
}
