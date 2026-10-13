import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface CodexBridgeConfigSection {
  enabled: boolean;
  sessionsDir: string;
  allowedWorkspaces: string;
  deniedWorkspaces: string;
  includeSubagents: boolean;
  stateDir: string;
  watchIntervalSeconds: number;
  watchMaxItems: number;
  maxReadBytes: number;
  maxScanBytes: number;
  notifyPhases: string;
  notifyUserMessages: boolean;
  notifyLifecycle: boolean;
  eventContentChars: number;
  notificationPolicy?: 'important' | 'all';
  workspaceFilesEnabled: boolean;
  workspaceMaxFileBytes: number;
  workspaceFileRoots: string;
}

export interface CodexBridgeAccess extends Omit<CodexBridgeConfigSection, 'allowedWorkspaces' | 'deniedWorkspaces' | 'notifyPhases' | 'workspaceFileRoots'> {
  allowedWorkspaces: string[];
  deniedWorkspaces: string[];
  notifyPhases: string[];
  workspaceFileRoots: string[];
}

export const CODEXBRIDGE_DEFAULTS: CodexBridgeConfigSection = {
  enabled: false, sessionsDir: join(homedir(), '.codex', 'sessions'),
  allowedWorkspaces: '[]', deniedWorkspaces: '[]', includeSubagents: false, stateDir: '',
  watchIntervalSeconds: 5, watchMaxItems: 20, maxReadBytes: 2 * 1024 * 1024, maxScanBytes: 8 * 1024 * 1024,
  notifyPhases: 'commentary,final_answer', notifyUserMessages: true, notifyLifecycle: true, eventContentChars: 400, notificationPolicy: 'important',
  workspaceFilesEnabled: false, workspaceMaxFileBytes: 1024 * 1024, workspaceFileRoots: '[]',
};

export const codexBridgeDefaults = (): CodexBridgeConfigSection => ({ ...CODEXBRIDGE_DEFAULTS });

function pathList(value: unknown, field: string, required: boolean): string[] {
  if (typeof value !== 'string') throw new Error(`${field} must be a JSON array of absolute paths.`);
  let list: unknown;
  try { list = JSON.parse(value); } catch { throw new Error(`${field} must be a JSON array.`); }
  if (!Array.isArray(list) || list.length > 100 || (required && list.length === 0) ||
      list.some(p => typeof p !== 'string' || !isAbsolute(p) || !p.trim())) throw new Error(`${field} contains an invalid absolute path.`);
  return [...new Set((list as string[]).map(p => resolve(p)))];
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  return value;
}

export function resolveCodexBridgeConfig(input: CodexBridgeConfigSection): CodexBridgeAccess {
  const cfg = { ...CODEXBRIDGE_DEFAULTS, ...input };
  if (typeof cfg.sessionsDir !== 'string' || !isAbsolute(cfg.sessionsDir)) throw new Error('sessionsDir must be absolute.');
  if (typeof cfg.stateDir !== 'string' || (cfg.stateDir !== '' && !isAbsolute(cfg.stateDir))) throw new Error('stateDir must be empty or absolute.');
  for (const key of ['includeSubagents','notifyUserMessages','notifyLifecycle','workspaceFilesEnabled'] as const) if (typeof cfg[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  if (typeof cfg.notifyPhases !== 'string') throw new Error('notifyPhases must be comma separated.');
  if (!['important','all'].includes(cfg.notificationPolicy ?? 'important')) throw new Error('notificationPolicy must be important or all.');
  const phases = [...new Set(cfg.notifyPhases.split(',').map(x=>x.trim()).filter(Boolean))];
  if (phases.some(p=>!['commentary','final_answer','message'].includes(p))) throw new Error('notifyPhases contains an unsupported public message phase.');
  return { ...cfg, sessionsDir: resolve(cfg.sessionsDir),
    allowedWorkspaces:pathList(cfg.allowedWorkspaces,'allowedWorkspaces',true),
    deniedWorkspaces:pathList(cfg.deniedWorkspaces,'deniedWorkspaces',false),notifyPhases:phases,
    workspaceFileRoots:pathList(cfg.workspaceFileRoots,'workspaceFileRoots',cfg.workspaceFilesEnabled),
    watchIntervalSeconds:integer(cfg.watchIntervalSeconds,'watchIntervalSeconds',0,3600),
    watchMaxItems:integer(cfg.watchMaxItems,'watchMaxItems',1,100),
    maxReadBytes:integer(cfg.maxReadBytes,'maxReadBytes',4096,32*1024*1024),
    maxScanBytes:integer(cfg.maxScanBytes,'maxScanBytes',4096,128*1024*1024),
    eventContentChars:integer(cfg.eventContentChars,'eventContentChars',50,2000),
    workspaceMaxFileBytes:integer(cfg.workspaceMaxFileBytes,'workspaceMaxFileBytes',1,8*1024*1024),
  };
}

export const CODEXBRIDGE_CONFIG_GROUP: ConfigGroup = {
  id:'world:codexbridge',owner:'world:codexbridge',
  schema:{type:'object',title:'Codex 会话桥接',properties:{
    'worlds.codexbridge.sessionsDir':{type:'string',title:'Codex 会话目录','x-hot':false,'x-path':{kind:'directory'}},
    'worlds.codexbridge.allowedWorkspaces':{type:'string',title:'允许读取的工作区','x-hot':false,description:'绝对路径的 JSON 数组；包含其子目录。'},
    'worlds.codexbridge.deniedWorkspaces':{type:'string',title:'排除的工作区','x-hot':false,description:'绝对路径的 JSON 数组；排除规则优先。'},
    'worlds.codexbridge.includeSubagents':{type:'boolean',title:'包含子代理任务','x-hot':false},
    'worlds.codexbridge.workspaceFilesEnabled':{type:'boolean',title:'允许按需读取项目文本文件','x-hot':false,description:'默认关闭；文件根只能缩小允许工作区，排除规则优先；无文件自动监测、推送或写入。'},
    'worlds.codexbridge.workspaceFileRoots':{type:'string',title:'允许读取文件的项目子目录','x-hot':false,description:'绝对路径JSON数组，默认[]；开启时必填，每个目录必须在allowedWorkspaces内，不能是整盘、HOME或敏感目录。'},
    'worlds.codexbridge.workspaceMaxFileBytes':{type:'integer',minimum:1,maximum:8388608,title:'项目文本文件字节上限','x-hot':false,description:'默认1MiB，最大8MiB；超出时读取前拒绝。无自动监测、推送或写入。'},
    'worlds.codexbridge.stateDir':{type:'string',title:'桥接日志与游标目录','x-hot':false,description:'留空使用当前部署的 data/codexbridge。'},
    'worlds.codexbridge.watchIntervalSeconds':{type:'integer',minimum:0,maximum:3600,title:'检查间隔（秒）','x-hot':false,description:'0 表示关闭后台推送。'},
    'worlds.codexbridge.watchMaxItems':{type:'integer',minimum:1,maximum:100,title:'每次轮询的条目上限','x-hot':false},
    'worlds.codexbridge.maxReadBytes':{type:'integer',minimum:4096,maximum:33554432,title:'每页读取字节目标预算','x-hot':false,description:'页首完整记录可原子扫描超出预算；超出量与上下文前缀扫描单独监测。'},
    'worlds.codexbridge.maxScanBytes':{type:'integer',minimum:4096,maximum:134217728,title:'每次扫描字节目标预算','x-hot':false,description:'按实际页扫描量扣减；首条完整大记录可超出，之后结束本轮。历史上下文重放另计。'},
    'worlds.codexbridge.notificationPolicy':{type:'string',enum:['important','all'],title:'任务通知策略','x-hot':false,description:'important：普通进展本地暂存，完成、需用户处理或额度错误时汇总一次；all：每页立即通知。'},
    'worlds.codexbridge.notifyPhases':{type:'string',title:'收录的助手消息阶段','x-hot':false,description:'commentary、final_answer、message，逗号分隔；important 策略下过程消息只暂存。'},
    'worlds.codexbridge.notifyUserMessages':{type:'boolean',title:'收录用户输入','x-hot':false},
    'worlds.codexbridge.notifyLifecycle':{type:'boolean',title:'收录任务开始、结束和中断','x-hot':false},
    'worlds.codexbridge.eventContentChars':{type:'integer',minimum:50,maximum:2000,title:'推送中每条正文字符上限','x-hot':false},
  }},
};
