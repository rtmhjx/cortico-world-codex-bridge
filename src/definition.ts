import type { WorldDefinition } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { codexBridgeDefaults,type CodexBridgeConfigSection } from './config.ts';
import { CodexBridgeWorld } from './world.ts';

export const CODEXBRIDGE:WorldDefinition<CodexBridgeConfigSection>={
  id:'codexbridge',label:'Codex 会话桥接',defaults:codexBridgeDefaults,
  create:ctx=>new CodexBridgeWorld({cfg:ctx.cfg,dataDir:ctx.dataDir,clock:()=>nowIso(ctx.timezone)}),
};
