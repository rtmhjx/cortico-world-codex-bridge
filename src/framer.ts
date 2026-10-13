import { readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { scrubTextPrefix } from './scrub.ts';

export class FrameError extends Error {
  constructor(readonly code:string,message:string) { super(message); }
}
export interface ProjectedRow { type?:string;timestamp?:string;payload?:Record<string,any>;projectionTruncated?:boolean;projectionCounts?:{content?:number;contentKinds?:number} }
export interface Frame { offset:number;endOffset:number;row:ProjectedRow;identity?:string }
export interface FrameScan { bytesScanned:number;budgetExceeded:boolean }
interface Budget { text:number;nodes:number;truncated:boolean }
type Mode='record'|'context'|'arguments'|'output';
type Path=Array<string|number|null>;
interface Container { type:'object'|'array';path:Path;value:any;keep:boolean;state:string;key:string|null;index:number }
interface StringToken { key:boolean;path:Path;keep:boolean;limit:number;strict:boolean;text:string[];length:number;captured:number;escape:string;unicode:string;nested?:Projection;invalidNested?:boolean;clipped:boolean }
const META_LIMIT=32768, MAX_DEPTH=256, MAX_NODES=32768, MAX_BLOCKS=256;
const bad=(message:string):never=>{throw new FrameError('MALFORMED_LINE',message);};
const limit=(message:string):never=>{throw new FrameError('PROJECTION_LIMIT',message);};
const metadata=new Set(['type','role','phase','channel','turn_id','id','cwd','name','agent_path','parent_thread_id','status','code','error_code','sandbox_permissions']);
const errorKeys=new Set(['code','type','message']);
const enumErrors=new Set(['UsageLimitExceeded','RateLimit','RateLimitExceeded','InsufficientCredits','QuotaExceeded']);

/** Validates all tokens; only selected public fields enter the retained tree. */
class Projection {
  readonly stack:Container[]=[];
  value:any;
  readonly counts:{content?:number;contentKinds?:number}={};
  private rootState='value';
  private string?:StringToken;
  private number?:{state:string;path:Path;keep:boolean;text:string;length:number};
  private literal?:{word:string;index:number;path:Path;keep:boolean};
  constructor(private readonly mode:Mode,private readonly budget:Budget) {}
  private path():Path {
    const parent=this.stack.at(-1);
    return !parent?[]:[...parent.path,parent.type==='array'?parent.index:parent.key];
  }
  private select(path:Path):boolean {
    if(path.some(p=>p===null))return false;
    if(path.length===0)return this.mode==='record'||this.mode==='context';
    if(this.mode==='arguments') {
      if(path.length===1)return ['questions','justification','sandbox_permissions'].includes(String(path[0]));
      if(path[0]!=='questions')return false;
      if(typeof path[1]==='number'&&path[1]>=32)limit('Too many structured user questions; source position was retained.');
      if(path.length===2)return true;
      if(path.length===3)return ['question','options'].includes(String(path[2]));
      if(path[2]!=='options')return false;
      if(typeof path[3]==='number'&&path[3]>=64)limit('Too many structured question choices; source position was retained.');
      return path.length===4||path.length===5&&['label','description'].includes(String(path[4]));
    }
    if(this.mode==='output')return path[0]==='error'&&(path.length===1||path.length===2&&errorKeys.has(String(path[1])));
    if(path.length===1)return ['type','timestamp','payload'].includes(String(path[0]));
    if(path[0]!=='payload')return false;
    const key=String(path[1]);
    if(this.mode==='context')return path.length===2&&['cwd','turn_id','type'].includes(key);
    if(path.length===2)return metadata.has(key)||['source','error','codex_error_info','message','content','internal_chat_message_metadata_passthrough','arguments','input','output','questions','justification'].includes(key);
    if(key==='source')return path.length===3&&path[2]==='subagent';
    if(key==='error')return path.length===3&&errorKeys.has(String(path[2]));
    if(key==='codex_error_info')return path.length===3&&enumErrors.has(String(path[2]));
    if(key==='content') {
      if(typeof path[2]!=='number')return false;
      if(path[2]>=MAX_BLOCKS) { this.budget.truncated=true;return false; }
      return path.length===3||path.length===4&&['type','text'].includes(String(path[3]));
    }
    if(key==='internal_chat_message_metadata_passthrough') {
      if(path.length===3)return ['turn_id','content_item_kinds'].includes(String(path[2]));
      if(path[2]==='content_item_kinds'&&path.length===4&&typeof path[3]==='number') {
        if(path[3]>=MAX_BLOCKS) { this.budget.truncated=true;return false; }return true;
      }
    }
    if(key==='questions') {
      const nested=new Projection('arguments',this.budget);
      return nested.select(['questions',...path.slice(2)]);
    }
    if(['arguments','input','output'].includes(key))return new Projection(key==='output'?'output':'arguments',this.budget).select(path.slice(2));
    return false;
  }
  private attach(path:Path,keep:boolean,value:any):void {
    const parent=this.stack.at(-1);
    if(keep) {
      if(++this.budget.nodes>MAX_NODES)limit('Retained public record exceeds the bounded node limit; source position was retained.');
      if(!parent)this.value=value;
      else if(parent.keep) {
        if(parent.type==='array')parent.value.push(value);
        else if(parent.key!==null)Object.defineProperty(parent.value,parent.key,{value,writable:true,enumerable:true,configurable:true});
      }
    } else if(parent?.keep&&parent.type==='object'&&parent.key!==null&&this.select(path)) {
      // A later unsupported value must overwrite an earlier retained value.
      // This preserves JSON.parse last-key semantics without storing it.
      delete parent.value[parent.key];
    }
    if(!parent)this.rootState='done';
    else { parent.state='comma';if(parent.type==='array')parent.index++; }
  }
  private stringRules(path:Path):{strict:boolean;limit:number} {
    const last=String(path.at(-1));
    const scalarError=this.mode==='record'&&path.length===2&&path[0]==='payload'&&last==='error';
    const strict=scalarError||metadata.has(last)||last==='codex_error_info'||last==='timestamp'||path.includes('content_item_kinds')||path.includes('source');
    return {strict,limit:strict?(last==='cwd'?META_LIMIT:scalarError?16384:512):this.budget.text};
  }
  private close(parent:Container):void {
    this.stack.pop();
    if(this.mode==='record'&&parent.type==='array') {
      if(parent.path.length===2&&parent.path[0]==='payload'&&parent.path[1]==='content')this.counts.content=parent.index;
      if(parent.path.length===3&&parent.path[0]==='payload'&&parent.path[1]==='internal_chat_message_metadata_passthrough'&&parent.path[2]==='content_item_kinds')this.counts.contentKinds=parent.index;
    }
    this.attach(parent.path,parent.keep,parent.value);
  }
  private append(text:string):void {
    const token=this.string!;token.length+=text.length;
    if(token.key) {
      if(token.captured<256) { const part=text.slice(0,256-token.captured);token.text.push(part);token.captured+=part.length; }
      return;
    }
    if(token.nested&&!token.invalidNested) {
      try { token.nested.feed(text); }
      catch(error) { if(error instanceof FrameError&&error.code==='MALFORMED_LINE')token.invalidNested=true;else throw error; }
      return;
    }
    if(token.nested)return;
    if(!token.keep)return;
    if(token.strict&&token.length>token.limit)limit(`Structural field ${token.path.join('.')} exceeds its safe limit; source position was retained.`);
    const remaining=token.strict?token.limit-token.captured:this.budget.text;
    const part=text.slice(0,Math.max(0,remaining));
    if(part) { token.text.push(part);token.captured+=part.length;if(!token.strict)this.budget.text-=part.length; }
    if(part.length<text.length) { token.clipped=true;this.budget.truncated=true; }
  }
  private endString():void {
    const token=this.string!;this.string=undefined;
    if(token.key) {
      const parent=this.stack.at(-1)!;parent.key=token.length<=256?token.text.join(''):null;parent.state='colon';return;
    }
    let value:any=token.text.join('');
    if(token.nested) {
      if(!token.invalidNested) {
        try { token.nested.finish();value=token.nested.value; }
        catch(error) { if(error instanceof FrameError&&error.code==='MALFORMED_LINE')value=null;else throw error; }
      } else value=null;
    } else if(token.keep&&!token.strict)value=scrubTextPrefix(value,token.clipped);
    this.attach(token.path,token.keep,value);
  }
  private beginString(key:boolean):void {
    const path=key?[]:this.path(),keep=!key&&this.select(path),rules=this.stringRules(path);
    const last=path.at(-1);
    const nested=keep&&this.mode==='record'&&path.length===2&&['arguments','input','output'].includes(String(last))?new Projection(last==='output'?'output':'arguments',this.budget):undefined;
    this.string={key,path,keep,limit:key?256:rules.limit,strict:rules.strict,text:[],length:0,captured:0,escape:'',unicode:'',nested,clipped:false};
  }
  private beginValue(c:string):void {
    const path=this.path(),nestedRoot=path.length===0&&(this.mode==='arguments'||this.mode==='output');
    const inlineNested=this.mode==='record'&&path.length===2&&path[0]==='payload'&&['arguments','input','output'].includes(String(path[1]));
    const keep=nestedRoot?c==='{':inlineNested&&c!=='{'&&c!=='"'?false:this.select(path);
    if(c==='{'||c==='[') {
      if(this.stack.length>=MAX_DEPTH)limit('JSON nesting exceeds the bounded depth limit; source position was retained.');
      this.stack.push({type:c==='{'?'object':'array',path,value:keep?(c==='{'?{}:[]):undefined,keep,state:c==='{'?'keyOrEnd':'valueOrEnd',key:null,index:0});return;
    }
    if(c==='"') { this.beginString(false);return; }
    if(c==='-'||c>='0'&&c<='9') { this.number={state:c==='-'?'sign':c==='0'?'zero':'integer',path,keep,text:keep?c:'',length:1};return; }
    const word=c==='t'?'true':c==='f'?'false':c==='n'?'null':null;
    if(word) { this.literal={word,index:1,path,keep};return; }
    bad('Invalid JSON value.');
  }
  feed(text:string):void {
    const special=/["\\\u0000-\u001f]/g;
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(this.string) {
        const token=this.string;
        if(token.escape==='unicode') {
          if(!/[0-9a-f]/i.test(c))bad('Invalid JSON Unicode escape.');token.unicode+=c;
          if(token.unicode.length===4) { token.escape='';this.append(String.fromCharCode(parseInt(token.unicode,16)));token.unicode=''; }continue;
        }
        if(token.escape==='slash') {
          token.escape='';if(c==='u') { token.escape='unicode';continue; }
          const decoded:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
          if(!(c in decoded))bad('Invalid JSON string escape.');this.append(decoded[c]);continue;
        }
        if(c==='"') { this.endString();continue; }
        if(c==='\\') { token.escape='slash';continue; }
        if(c.charCodeAt(0)<32)bad('Unescaped control character in JSON string.');
        special.lastIndex=i;const match=special.exec(text),end=match?.index??text.length;
        this.append(text.slice(i,end));i=end-1;continue;
      }
      if(this.number) {
        const n=this.number,digit=c>='0'&&c<='9';let consumed=true;
        if(n.state==='sign') { if(!digit)bad('Invalid JSON number.');n.state=c==='0'?'zero':'integer'; }
        else if(n.state==='zero') { if(digit)bad('Leading zero in JSON number.');if(c==='.')n.state='dot';else if(c==='e'||c==='E')n.state='exponent';else consumed=false; }
        else if(n.state==='integer') { if(c==='.')n.state='dot';else if(c==='e'||c==='E')n.state='exponent';else if(!digit)consumed=false; }
        else if(n.state==='dot') { if(!digit)bad('Invalid JSON fraction.');n.state='fraction'; }
        else if(n.state==='fraction') { if(c==='e'||c==='E')n.state='exponent';else if(!digit)consumed=false; }
        else if(n.state==='exponent') { if(c==='+'||c==='-')n.state='exponentSign';else if(digit)n.state='exponentDigits';else bad('Invalid JSON exponent.'); }
        else if(n.state==='exponentSign') { if(!digit)bad('Invalid JSON exponent.');n.state='exponentDigits'; }
        else if(!digit)consumed=false;
        if(consumed) { n.length++;if(n.keep) { if(n.length>128)limit('Retained numeric field exceeds its safe limit.');n.text+=c; }continue; }
        this.number=undefined;this.attach(n.path,n.keep,n.keep?Number(n.text):undefined);i--;continue;
      }
      if(this.literal) {
        const l=this.literal;if(c!==l.word[l.index])bad('Invalid JSON literal.');l.index++;
        if(l.index===l.word.length) { this.literal=undefined;this.attach(l.path,l.keep,l.word==='null'?null:l.word==='true'); }continue;
      }
      if(c===' '||c==='\t'||c==='\r'||c==='\n')continue;
      const parent=this.stack.at(-1);
      if(!parent) { if(this.rootState==='done')bad('Extra data after JSON value.');this.beginValue(c);continue; }
      if(parent.state==='colon') { if(c!==':')bad('Missing JSON property colon.');parent.state='value';continue; }
      if(parent.state==='comma') {
        if(c===',') { parent.state=parent.type==='object'?'key':'value';continue; }
        if(c===(parent.type==='object'?'}':']')) { this.close(parent);continue; }
        bad('Missing JSON separator.');
      }
      if(parent.type==='object'&&(parent.state==='key'||parent.state==='keyOrEnd')) {
        if(c==='}'&&parent.state==='keyOrEnd') { this.close(parent);continue; }
        if(c!=='"')bad('Invalid JSON property name.');this.beginString(true);continue;
      }
      if(parent.type==='array'&&parent.state==='valueOrEnd'&&c===']') { this.close(parent);continue; }
      this.beginValue(c);
    }
  }
  finish():void {
    if(this.number) {
      const n=this.number;if(!['zero','integer','fraction','exponentDigits'].includes(n.state))bad('Incomplete JSON number.');
      this.number=undefined;this.attach(n.path,n.keep,n.keep?Number(n.text):undefined);
    }
    if(this.string||this.literal||this.stack.length||this.rootState!=='done')bad('Incomplete JSON record.');
  }
}

/** The first record may finish past softEnd; later records stay within it. */
export function* frames(fd:number,start:number,hardEnd:number,options:{softEnd?:number;maxChars:number;contextOnly?:boolean;identityPrefix?:string;scan?:FrameScan}):Generator<Frame> {
  const scan=options.scan??{bytesScanned:0,budgetExceeded:false},softEnd=Math.min(options.softEnd??hardEnd,hardEnd);
  let pos=start,lineStart=start,first=true;
  const buffer=Buffer.alloc(64*1024);
  let budget:Budget={text:options.maxChars,nodes:0,truncated:false};
  let parser=new Projection(options.contextOnly?'context':'record',budget),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  let hash=options.identityPrefix===undefined?undefined:createHash('sha256').update(options.identityPrefix);
  while(pos<hardEnd&&(pos<softEnd||first)) {
    const readEnd=first?hardEnd:softEnd;
    const count=readSync(fd,buffer,0,Math.min(buffer.length,readEnd-pos),pos);if(!count)break;
    let index=0;
    while(index<count) {
      if(pos>=softEnd&&!first)return;
      const lf=buffer.subarray(index,count).indexOf(10),end=lf<0?count:index+lf;
      const allowed=first?end:Math.min(end,index+softEnd-pos),bytes=buffer.subarray(index,allowed);
      try { hash?.update(bytes);parser.feed(decoder.decode(bytes,{stream:true})); }
      catch(error) { if(error instanceof FrameError)throw new FrameError(error.code,`${error.message} Record starts at byte ${lineStart}.`);throw new FrameError('MALFORMED_LINE',`Invalid UTF-8 in record at byte ${lineStart}.`); }
      pos+=bytes.length;index=allowed;scan.bytesScanned+=bytes.length;
      if(allowed!==end)return;
      if(lf<0)break;
      if(!first&&pos>=softEnd)return;
      try { parser.feed(decoder.decode());parser.finish(); }
      catch(error) { if(error instanceof FrameError)throw new FrameError(error.code,`${error.message} Record starts at byte ${lineStart}.`);throw new FrameError('MALFORMED_LINE',`Invalid UTF-8 in record at byte ${lineStart}.`); }
      pos++;index++;scan.bytesScanned++;scan.budgetExceeded ||=pos>softEnd;
      const row=parser.value;
      if(!row||typeof row!=='object'||Array.isArray(row))throw new FrameError('MALFORMED_LINE',`Invalid JSONL object at byte ${lineStart}.`);
      if(budget.truncated)row.projectionTruncated=true;
      row.projectionCounts=parser.counts;
      const frame={offset:lineStart,endOffset:pos,row,identity:hash?.digest('hex')};
      yield frame;
      lineStart=pos;first=false;hash=undefined;
      budget={text:options.maxChars,nodes:0,truncated:false};parser=new Projection(options.contextOnly?'context':'record',budget);decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
      if(pos>=softEnd)return;
    }
  }
  // A caller supplies a complete-LF hardEnd. A partial budget tail is retained
  // by the source cursor and retried as the next page's first record.
  if(pos===hardEnd&&lineStart!==hardEnd)throw new FrameError('MALFORMED_LINE',`Source boundary is not a complete record at byte ${lineStart}.`);
}
