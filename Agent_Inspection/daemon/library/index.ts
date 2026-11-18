import { Notifier } from '../notify/notifier.ts';
import { WaystationAutomation } from '../automation/automation.ts';
import { BrainConnections } from '../architecture/brains.ts';
import { AgentResources } from '../architecture/resources.ts';
import { AgentRuns } from '../architecture/runs.ts';
import { AgentPlatform } from '../architecture/platform.ts';
import { AgentSecrets } from '../architecture/secrets.ts';
import { AgentSandboxes } from '../architecture/sandboxes.ts';
import { AgentEvaluations } from '../architecture/evaluations.ts';
import { ConnectorBroker } from '../connectors/broker.ts';
import { CodexPluginCatalog } from './codexPluginCatalog.ts';
import { ContextDocs } from './contextDocs.ts';
import type { LibraryDeps } from './deps.ts';
import { McpCatalog } from './mcpCatalog.ts';
import { AgentToolBuilder } from '../architecture/toolBuilder.ts';
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
  /** Codex's own plugins (`codex plugin`): managed here, loaded by Codex from its config, not per agent. */
  readonly codexPlugins: CodexPluginCatalog;
  readonly notifier: Notifier;
  readonly automation: WaystationAutomation;
  readonly brains: BrainConnections;
  readonly resources: AgentResources;
  readonly agentRuns: AgentRuns;
  readonly agentPlatform: AgentPlatform;
  readonly agentSecrets: AgentSecrets;
  readonly agentSandboxes: AgentSandboxes;
  readonly agentEvaluations: AgentEvaluations;
  /** One-step "Add tool": describe-to-generate, MCP by URL/preset/Library, web search, code execution. */
  readonly agentTools: AgentToolBuilder;
  readonly connectors: ConnectorBroker;

  constructor(readonly deps: LibraryDeps) {
    this.skills = new SkillLibrary(deps);
    this.docs = new ContextDocs(deps);
    this.mcp = new McpCatalog(deps);
    this.plugins = new PluginCatalog(deps);
    this.codexPlugins = new CodexPluginCatalog(deps);
    this.notifier = new Notifier(deps);
    this.automation = new WaystationAutomation(deps.store);
    this.brains = new BrainConnections(deps);
    this.resources = new AgentResources(deps);
    this.agentRuns = new AgentRuns(deps, this.automation.architectures, this.brains, this.resources);
    this.agentPlatform = new AgentPlatform(deps, this.automation.architectures, this.brains, this.resources, this.agentRuns);
    this.agentSecrets = new AgentSecrets(deps);
    this.agentSandboxes = new AgentSandboxes(deps, (project, text) => this.brains.sanitize(project, this.resources.sanitize(project, text)));
    this.agentRuns.sandboxes = this.agentSandboxes;
    this.agentEvaluations = new AgentEvaluations(deps, this.agentPlatform, this.agentRuns, this.brains, this.agentSandboxes);
    this.agentTools = new AgentToolBuilder(deps, this.automation.architectures, this.agentPlatform, this.brains, this.agentSandboxes, this.resources);
    this.agentTools.library = this.mcp;
    this.connectors = new ConnectorBroker(deps);
    this.automation.capabilityMetadata = project => this.agentPlatform.capabilities(project).map(c => ({ id: c.id, version: c.version, name: c.name, kind: c.spec.kind, description: c.description }));
    this.automation.runResources = this.agentRuns;
    this.notifier.on('revoke', (id: string) => this.automation.revoke(id));
  }

  /** In order: required reading and skills first, then tools. */
  get providers(): readonly LoadoutProvider[] {
    return [this.docs, this.skills, this.mcp, this.plugins, this.notifier];
  }
}
