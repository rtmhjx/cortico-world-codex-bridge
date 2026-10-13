import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Dir, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface WorkspaceFilesOptions {
  roots: string[];
  denied: string[];
  maxFileBytes: number;
  scrub: (text: string) => string;
}
export const WORKSPACE_LIMITS = Object.freeze({maxFileBytes:8*1024*1024,readChars:32000,listItems:100,searchMatches:20,
  entryScan:512,searchFiles:32,searchBytes:8*1024*1024,cursors:16,cursorLifetimeMs:5*60*1000,pendingDirectories:1024});
export class WorkspaceFilesError extends Error {
  constructor(public readonly code:string,message:string) {super(`${code}: ${message}`);this.name='WorkspaceFilesError';}
}
const fail=(code:string,message:string):never=>{throw new WorkspaceFilesError(code,message);};
const fold=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
const within=(p:string,root:string)=>{const r=relative(fold(root),fold(p));return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`));};
const same=(a:string,b:string)=>fold(a)===fold(b);
const identity=(s:Stats)=>`${s.dev}:${s.ino}:${s.birthtimeMs}`;
const stamp=(s:Stats)=>`${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;
const TEXT_EXTENSIONS=new Set(['.txt','.md','.mdx','.rst','.adoc','.json','.jsonc','.yaml','.yml','.toml','.ini','.cfg','.xml',
  '.html','.htm','.css','.scss','.sass','.less','.svg','.js','.jsx','.mjs','.cjs','.ts','.tsx','.vue','.svelte','.py','.pyi',
  '.rb','.go','.rs','.java','.kt','.kts','.c','.h','.cc','.cpp','.hpp','.cs','.fs','.sh','.bash','.zsh','.ps1','.psm1',
  '.bat','.cmd','.sql','.graphql','.gql','.proto','.prisma','.gradle','.cmake','.make','.properties','.ipynb']);
const TEXT_NAMES=new Set(['readme','license','licence','notice','copying','changelog','authors','dockerfile','containerfile','makefile','cmakelists.txt','justfile','procfile','gemfile','rakefile']);
const BLOCKED_PARTS=new Set(['.git','node_modules','venv','env','build','dist','target','out','coverage','cache','caches','__pycache__',
  'credentials','credential','secrets','privatekeys','private-keys','certificates','certs','keystore','keychains','sessions','session',
  'logs','log','audit','archives','archive','backups','backup','对话备份','对话记录']);
const device=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i;
const unsafeName=(part:string)=>!part||part==='.'||part==='..'||part.length>255||/[<>:"|?*\x00-\x1f\x7f]/.test(part)||/[. ]$/.test(part)||device.test(part);
const blockedName=(part:string)=>part.startsWith('.')||BLOCKED_PARTS.has(part.toLowerCase())||/^(?:credentials?|secrets?|passwords?|passwd|cookies?|tokens?|auth)(?:[-_.].*)?\.(?:json|jsonc|ya?ml|toml|ini|cfg|txt)$/i.test(part)||/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(part);
const textName=(name:string)=>TEXT_EXTENSIONS.has(extname(name).toLowerCase())||TEXT_NAMES.has(name.toLowerCase());
function args(value:Record<string,unknown>,allowed:string[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('INVALID_ARGUMENT','Unknown or invalid argument.');
}
function integer(value:unknown,fallback:number,min:number,max:number):number {
  const n=value??fallback;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>max)fail('INVALID_ARGUMENT','Numeric argument is out of range.');return n as number;
}
function str(value:unknown,max:number):string {if(typeof value!=='string'||!value||value.length>max)fail('INVALID_ARGUMENT','A bounded nonempty string is required.');return value as string;}
function parts(path:string):string[] {
  if(path==='.')return [];
  if(isAbsolute(path)||/^[A-Za-z]:|^[\\/]/.test(path))fail('INVALID_PATH','path must be relative to the selected root.');
  const all=path.split(/[\\/]/);if(all.some(unsafeName))fail('INVALID_PATH','Path traversal, device names, ADS and ambiguous names are not accepted.');
  return all;
}
type Root={path:string;identity:string};
type Walk={root:Root;path:string;recursive:boolean;queue:string[];current?:{path:string;handle:Dir};pending?:Entry;done:boolean;skipped:number;reasons:Set<string>};
type Entry={path:string;type:'file'|'directory';bytes:number};
type Continuation={key:string;at:number;walk:Walk;timer:ReturnType<typeof setTimeout>};

/** Read-only, explicitly rooted project text access. No project code is executed. */
export class WorkspaceFiles {
  private roots:Root[]=[];
  private denied:string[]=[];
  private deniedConfigured:string[]=[];
  private continuations=new Map<string,Continuation>();
  constructor(private readonly options:WorkspaceFilesOptions) {
    if(!Number.isSafeInteger(options.maxFileBytes)||options.maxFileBytes<1||options.maxFileBytes>WORKSPACE_LIMITS.maxFileBytes)fail('INVALID_CONFIG','maxFileBytes must be 1..8388608.');
    if(!Array.isArray(options.roots)||!options.roots.length||options.roots.length>100||!Array.isArray(options.denied)||options.denied.length>100||typeof options.scrub!=='function')fail('INVALID_CONFIG','Explicit roots, denied roots and a scrub function are required.');
    this.denied=options.denied.flatMap(p=>{
      if(typeof p!=='string'||!isAbsolute(p))return fail('INVALID_CONFIG','Denied roots must be absolute.');
      const lexical=resolve(p);this.deniedConfigured.push(lexical);
      try{return [lexical,realpathSync.native(lexical)];}catch{return [lexical];}
    });
    const home=resolve(homedir());
    for(const configured of options.roots) {
      if(typeof configured!=='string'||!isAbsolute(configured))fail('INVALID_ROOT','Project roots must be absolute.');
      const path=resolve(configured),root=parse(path).root;
      const components=path.slice(root.length).split(sep).filter(Boolean);
      if(path===root||within(home,path)||components.some(p=>unsafeName(p)||blockedName(p))||/^\\\\/.test(path))fail('INVALID_ROOT','Use a specific project directory, not a filesystem/home/protected/source/cache root.');
      if(this.isDenied(path))fail('DENIED','A project root is inside a denied directory.');
      this.checkComponents(path);
      const stat=lstatSync(path);
      if(!stat.isDirectory())fail('INVALID_ROOT','A project root must be a real directory.');
      if(!this.roots.some(r=>same(r.path,path)))this.roots.push({path,identity:identity(stat)});
    }
  }
  close():void {for(const entry of this.continuations.values()){clearTimeout(entry.timer);this.closeWalk(entry.walk);}this.continuations.clear();}
  private isDenied(path:string):boolean {
    // Retain the initial logical/canonical exclusions, and also deny a newly
    // resolved junction target under its direct path. Missing targets never
    // remove a configured logical exclusion. This is not an atomic sandbox.
    const current=this.deniedConfigured.flatMap(p=>{try{return [realpathSync.native(p)];}catch{return [];}});
    return [...this.denied,...current].some(d=>within(path,d));
  }
  private checkComponents(path:string):void {
    const root=parse(path).root;let current=root;
    for(const part of path.slice(root.length).split(sep).filter(Boolean)) {
      current=join(current,part);
      const stat=lstatSync(current);
      if(stat.isSymbolicLink()||!same(realpathSync.native(current),current))fail('UNSAFE_LINK','Symlinks, junctions and redirected paths are not accepted.');
    }
  }
  private selected(rootValue:unknown):Root {
    const value=str(rootValue,4096);
    if(!isAbsolute(value))fail('INVALID_ROOT','root must match an authorized absolute project root.');
    const root=this.roots.find(r=>same(r.path,resolve(value)));
    if(!root)fail('INVALID_ROOT','root must match an authorized project root.');
    this.checkComponents(root!.path);
    if(this.isDenied(root!.path)||identity(lstatSync(root!.path))!==root!.identity)fail('SOURCE_CHANGED','The authorized project root was replaced.');
    return root!;
  }
  private checked(root:Root,path:string,want?:'file'|'directory'):{full:string;stat:Stats} {
    const segments=parts(path);
    if(segments.some(blockedName))fail('EXCLUDED','Hidden, credential, cache, log and session paths are excluded.');
    const full=join(root.path,...segments);
    if(!within(full,root.path)||this.isDenied(full))fail('DENIED','Path is outside the authorized scope.');
    this.selected(root.path);this.checkComponents(full);
    const resolved=realpathSync.native(full);
    if(!within(resolved,root.path)||this.isDenied(resolved)||!same(resolved,full))fail('DENIED','Resolved path is outside the authorized scope.');
    const stat=lstatSync(full);
    if(want==='directory'&&!stat.isDirectory()||want==='file'&&!stat.isFile()||!stat.isDirectory()&&!stat.isFile())fail('UNSUPPORTED_FILE','Only regular project files and directories are accepted.');
    if(stat.isFile()&&(stat.nlink!==1||!textName(basename(full))))fail('EXCLUDED','Hard links and files outside the text allowlist are excluded.');
    return {full,stat};
  }
  private load(root:Root,path:string,budget={remaining:WORKSPACE_LIMITS.maxFileBytes,read:0}):{text:string;bytes:number;version:string} {
    const before=this.checked(root,path,'file');
    if(before.stat.size>this.options.maxFileBytes)fail('FILE_TOO_LARGE','File exceeds workspaceMaxFileBytes; no file body was read.');
    if(before.stat.size>budget.remaining)fail('SCAN_BUDGET','File no longer fits the remaining scan budget.');
    const fd=openSync(before.full,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const opened=fstatSync(fd);
      if(stamp(opened)!==stamp(before.stat)||!opened.isFile()||opened.nlink!==1)fail('SOURCE_CHANGED','File identity changed before reading.');
      const validated=this.checked(root,path,'file');
      if(stamp(validated.stat)!==stamp(opened))fail('SOURCE_CHANGED','File path changed before reading.');
      const bytes=Buffer.alloc(opened.size);let offset=0;
      while(offset<bytes.length) {
        const n=readSync(fd,bytes,offset,Math.min(64*1024,bytes.length-offset),offset);
        if(!n)fail('SOURCE_CHANGED','File length changed while reading.');offset+=n;budget.read+=n;
      }
      if(stamp(fstatSync(fd))!==stamp(opened)||stamp(this.checked(root,path,'file').stat)!==stamp(opened))fail('SOURCE_CHANGED','File or project path changed while reading.');
      if(bytes.includes(0))fail('BINARY_FILE','NUL-containing files are not supported.');
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return fail('NON_UTF8','Only valid UTF-8 text is supported.');}
      if(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d:/i.test(text))fail('PRIVATE_KEY','Private key content is not returned.');
      return {text:this.options.scrub(text),bytes:bytes.length,version:createHash('sha256').update(bytes).digest('hex')};
    } finally {closeSync(fd);}
  }
  read(input:Record<string,unknown>):Record<string,unknown> {
    args(input,['root','path','offset','maxChars']);const root=this.selected(input.root),path=str(input.path,4096);
    const offset=integer(input.offset,0,0,Number.MAX_SAFE_INTEGER),maxChars=integer(input.maxChars,16000,1,WORKSPACE_LIMITS.readChars);
    const file=this.load(root,path);if(offset>file.text.length)fail('INVALID_OFFSET','offset exceeds the scrubbed text length.');
    if(offset>0&&/[\uD800-\uDBFF]/.test(file.text[offset-1])&&/[\uDC00-\uDFFF]/.test(file.text[offset]??''))fail('INVALID_OFFSET','offset splits a Unicode character.');
    let end=Math.min(file.text.length,offset+maxChars);if(end<file.text.length&&/[\uD800-\uDBFF]/.test(file.text[end-1]))end--;
    if(end===offset&&end<file.text.length)fail('INVALID_ARGUMENT','maxChars is too small for the next Unicode character.');
    return {root:root.path,path:parts(path).join('/'),bytes:file.bytes,version:file.version,offset,content:file.text.slice(offset,end),nextOffset:end<file.text.length?end:null,truncated:end<file.text.length,offsetUnit:'scrubbed UTF-16 characters'};
  }
  private closeWalk(walk:Walk):void {try{walk.current?.handle.closeSync();}catch{}walk.current=undefined;}
  private begin(input:Record<string,unknown>,operation:'list'|'search'):Walk {
    let root:Root;const path=str(input.path,4096),query=operation==='search'?str(input.query,200):'';
    try {root=this.selected(input.root);this.checked(root,path,'directory');}
    catch(error) {
      if(!(error instanceof WorkspaceFilesError)||['SOURCE_CHANGED','DENIED','UNSAFE_LINK'].includes(error.code)) {
        const token=typeof input.cursor==='string'?input.cursor:'',saved=this.continuations.get(token);
        if(saved){clearTimeout(saved.timer);this.closeWalk(saved.walk);this.continuations.delete(token);}
      }
      throw error;
    }
    const key=JSON.stringify([operation,root.path,parts(path),query]);
    for(const [token,saved]of this.continuations)if(Date.now()-saved.at>WORKSPACE_LIMITS.cursorLifetimeMs){clearTimeout(saved.timer);this.closeWalk(saved.walk);this.continuations.delete(token);}
    if(input.cursor!==undefined) {
      const token=str(input.cursor,100),saved=this.continuations.get(token);
      if(!saved||saved.key!==key)fail('INVALID_CURSOR','Cursor expired, was consumed, or does not match this request.');
      clearTimeout(saved!.timer);this.continuations.delete(token);return saved!.walk;
    }
    if(this.continuations.size>=WORKSPACE_LIMITS.cursors)fail('CURSOR_LIMIT','Finish existing list/search pages before opening another traversal.');
    return {root,path,recursive:operation==='search',queue:[path],done:false,skipped:0,reasons:new Set()};
  }
  private next(walk:Walk,budget:{entries:number}):Entry|undefined {
    if(walk.pending){const entry=walk.pending;walk.pending=undefined;return entry;}
    while(budget.entries<WORKSPACE_LIMITS.entryScan&&!walk.done) {
      if(!walk.current) {
        const path=walk.queue.shift();if(path===undefined){walk.done=true;return;}
        try {walk.current={path,handle:opendirSync(this.checked(walk.root,path,'directory').full,{bufferSize:32})};}
        catch(error){walk.skipped++;walk.reasons.add(error instanceof WorkspaceFilesError?error.code:'DIRECTORY_UNAVAILABLE');continue;}
      }
      const current=walk.current;let entry;
      try {this.checked(walk.root,current.path,'directory');entry=current.handle.readSync();}
      catch(error){walk.skipped++;walk.reasons.add(error instanceof WorkspaceFilesError?error.code:'DIRECTORY_UNAVAILABLE');this.closeWalk(walk);continue;}
      if(!entry){this.closeWalk(walk);continue;}budget.entries++;
      if(unsafeName(entry.name)||blockedName(entry.name)||entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile()){walk.skipped++;continue;}
      const path=current.path==='.'?entry.name:current.path+'/'+entry.name;
      try {
        const info=this.checked(walk.root,path);
        if(info.stat.isDirectory()) {
          if(walk.recursive) {
            if(walk.queue.length>=WORKSPACE_LIMITS.pendingDirectories){walk.skipped++;walk.reasons.add('DIRECTORY_QUEUE_LIMIT');}
            else walk.queue.push(path);
            continue;
          }
          return {path,type:'directory',bytes:0};
        }
        return {path,type:'file',bytes:info.stat.size};
      } catch(error){walk.skipped++;if(!(error instanceof WorkspaceFilesError)||!['EXCLUDED','DENIED','UNSAFE_LINK'].includes(error.code))walk.reasons.add(error instanceof WorkspaceFilesError?error.code:'FILE_UNAVAILABLE');}
    }
    return;
  }
  private finish(walk:Walk,operation:'list'|'search',query=''):Record<string,unknown> {
    let nextCursor:string|null=null;
    if(!walk.done) {
      if(this.continuations.size>=WORKSPACE_LIMITS.cursors)fail('CURSOR_LIMIT','Finish existing list/search pages before opening another traversal.');
      nextCursor=randomUUID();const token=nextCursor;
      const timer=setTimeout(()=>{const saved=this.continuations.get(token);if(saved){this.closeWalk(saved.walk);this.continuations.delete(token);}},WORKSPACE_LIMITS.cursorLifetimeMs);timer.unref();
      this.continuations.set(nextCursor,{key:JSON.stringify([operation,walk.root.path,parts(walk.path),query]),at:Date.now(),walk,timer});
    } else this.closeWalk(walk);
    return {nextCursor,truncated:!walk.done||walk.reasons.size>0,incompleteReasons:[...walk.reasons],skipped:walk.skipped,
      coverage:'Eligible text files only; filesystem traversal is not a snapshot.',cursorExpiresInSeconds:nextCursor?WORKSPACE_LIMITS.cursorLifetimeMs/1000:null};
  }
  list(input:Record<string,unknown>):Record<string,unknown> {
    args(input,['root','path','cursor','limit']);const limit=integer(input.limit,40,1,WORKSPACE_LIMITS.listItems),walk=this.begin(input,'list'),budget={entries:0},entries:Entry[]=[];
    try {while(entries.length<limit){const entry=this.next(walk,budget);if(!entry)break;entries.push(entry);}return {root:walk.root.path,path:walk.path,entries,scannedEntries:budget.entries,...this.finish(walk,'list')};}
    catch(error){this.closeWalk(walk);throw error;}
  }
  search(input:Record<string,unknown>):Record<string,unknown> {
    args(input,['root','path','query','cursor','limit']);const query=str(input.query,200),limit=integer(input.limit,10,1,WORKSPACE_LIMITS.searchMatches),walk=this.begin(input,'search'),budget={entries:0};
    const matches:Array<Record<string,unknown>>=[];let scannedFiles=0,scannedBytes=0;
    try {
      while(matches.length<limit&&scannedFiles<WORKSPACE_LIMITS.searchFiles) {
        const entry=this.next(walk,budget);if(!entry)break;
        if(entry.bytes>this.options.maxFileBytes){walk.skipped++;walk.reasons.add('FILE_TOO_LARGE');continue;}
        if(entry.bytes>WORKSPACE_LIMITS.searchBytes-scannedBytes){walk.pending=entry;break;}
        const io={remaining:WORKSPACE_LIMITS.searchBytes-scannedBytes,read:0};
        try {
          const file=this.load(walk.root,entry.path,io);scannedFiles++;
          const position=file.text.indexOf(query);if(position<0)continue;
          let from=Math.max(0,position-120),to=Math.min(file.text.length,position+query.length+280);
          if(from>0&&/[\uDC00-\uDFFF]/.test(file.text[from]))from--;
          if(to<file.text.length&&/[\uD800-\uDBFF]/.test(file.text[to-1]))to--;
          matches.push({path:entry.path,bytes:file.bytes,version:file.version,offset:position,excerpt:file.text.slice(from,to),excerpted:from>0||to<file.text.length});
        } catch(error){
          if(error instanceof WorkspaceFilesError&&error.code==='SCAN_BUDGET'){walk.pending=entry;break;}
          scannedFiles++;walk.skipped++;walk.reasons.add(error instanceof WorkspaceFilesError?error.code:'FILE_UNAVAILABLE');
        } finally {scannedBytes+=io.read;}
      }
      return {root:walk.root.path,path:walk.path,matches,scannedFiles,scannedBytes,scannedEntries:budget.entries,...this.finish(walk,'search',query)};
    } catch(error){this.closeWalk(walk);throw error;}
  }
}
