import { Notifier } from '../notify/notifier.ts';
import { ContextDocs } from './contextDocs.ts';
import type { LibraryDeps } from './deps.ts';
import { McpCatalog } from './mcpCatalog.ts';
import { PluginCatalog } from './pluginCatalog.ts';
import { SkillLibrary } from './skillLibrary.ts';
import type { LoadoutProvider } from './types.ts';

export type { LibraryDeps } from './deps.ts';

/** Skills, context docs, MCP servers, plugins and notification channels: what agents can be given. */
export class Library {
  readonly skills: SkillLibrary;
  readonly docs: ContextDocs;
  readonly mcp: McpCatalog;
  readonly plugins: PluginCatalog;
  readonly notifier: Notifier;

  constructor(readonly deps: LibraryDeps) {
    this.skills = new SkillLibrary(deps);
    this.docs = new ContextDocs(deps);
    this.mcp = new McpCatalog(deps);
    this.plugins = new PluginCatalog(deps);
    this.notifier = new Notifier(deps);
  }

  /** In order: required reading and skills first, then tools. */
  get providers(): readonly LoadoutProvider[] {
    return [this.docs, this.skills, this.mcp, this.plugins, this.notifier];
  }
}
