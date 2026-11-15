import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TowerStore } from '../store/db.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import { AgentTokens } from '../notify/agentTokens.ts';
import { tokensMatch } from '../api/security.ts';
import { TeamAuthError } from '../teams/teamManager.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot, listFolder } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import { CanvasStore } from './canvas.ts';
import { ArchitectureStore } from '../architecture/store.ts';
import { SketchStore } from '../sketch/sketchStore.ts';
import { sketchForAgents, planningBrief, SKETCH_LIBRARY } from '../../shared/sketch.ts';
import { WAYSTATION_TOOLS } from './tools.ts';
import type { Agent } from '../domain/types.ts';
import type { ConsoleInfo } from '../pty/types.ts';
import type { BrainConnection } from '../../shared/agentBrains.ts';

export const AUTOMATION_SCRIPT = fileURLToPath(new URL('./waystation-mcp.mjs', import.meta.url));
export const AUTOMATION_TOKEN_ENV = 'WAYSTATION_MCP_TOKEN';
export interface AutomationGrant { readonly agentId: string; readonly cwd?: string; readonly resourcesRunId?: string }
export interface CanvasReveal { readonly id: string; readonly project: string; readonly requestId: string }

export class WaystationAutomation extends EventEmitter {
  /** Dedicated local capability: never grants agent launch, shell input, approvals or settings access. */
  readonly token = randomBytes(24).toString('hex');
  readonly canvas: CanvasStore;
  readonly architectures: ArchitectureStore;
  /** Each project's planning sketch on the console board: agents read and edit it with get_sketch and update_sketch. */
  readonly sketches: SketchStore;
  private endpoint?: string;
  private readonly tokens = new AgentTokens();
  private readonly scopes = new Map<string, string>();
  private readonly runScopes = new Map<string, string>();
  runResources?: { callResource: (runId: string, actorId: string, name: string, args: Record<string, unknown>) => Promise<unknown> };
  capabilityMetadata?: (project: string) => unknown[];

  constructor(private readonly store: TowerStore) { super(); this.canvas = new CanvasStore(store); this.architectures = new ArchitectureStore(store); this.sketches = new SketchStore(store); }
  setEndpoint(endpoint: string): void { this.endpoint = endpoint; this.canvas.origin = endpoint; }
  attachDefaults(launch: ManagedLaunch): ManagedLaunch {
    if (launch.toolPolicy) return launch;
    if (!this.endpoint) return launch;
    const existing = launch.mcpServers?.waystation;
    if (existing && !existing.args.includes(AUTOMATION_SCRIPT) || launch.remoteMcpServers?.waystation) throw new LibraryInputError('The MCP name "waystation" is reserved for the application bridge. Rename your custom server.');
    const agentId = launch.agentId ?? `managed:${randomUUID()}`;
    const token = this.tokens.issue(agentId, launch.name, []);
    this.scopes.set(agentId, launch.cwd);
    return { ...launch, agentId, mcpServers: { ...launch.mcpServers, waystation: {
      command: process.execPath, args: [AUTOMATION_SCRIPT],
      env: { WAYSTATION_MCP_URL: this.endpoint, WAYSTATION_MCP_CWD: launch.cwd }, inheritEnv: [AUTOMATION_TOKEN_ENV],
    } }, env: { ...launch.env, [AUTOMATION_TOKEN_ENV]: token } };
  }
  attachResources(launch: ManagedLaunch, runId: string): ManagedLaunch {
    if (!this.endpoint || !launch.agentId) throw new LibraryInputError('Resource bridge is not ready.');
    const token = this.tokens.issue(launch.agentId, launch.name, []); this.scopes.set(launch.agentId, launch.cwd); this.runScopes.set(launch.agentId, runId);
    return { ...launch, mcpServers: { agent_resources: { command: process.execPath, args: [AUTOMATION_SCRIPT], env: { WAYSTATION_MCP_URL: this.endpoint, WAYSTATION_MCP_CWD: launch.cwd }, inheritEnv: [AUTOMATION_TOKEN_ENV] } }, env: { ...launch.env, [AUTOMATION_TOKEN_ENV]: token } };
  }
  toolsFor(grant: AutomationGrant) { return WAYSTATION_TOOLS.filter(t => grant.resourcesRunId ? ['call_agent_tool', 'get_agent_memory', 'put_agent_memory'].includes(t.name) : !['call_agent_tool', 'get_agent_memory', 'put_agent_memory'].includes(t.name)); }
  revoke(agentId: string): void { this.tokens.revoke(agentId); this.scopes.delete(agentId); this.runScopes.delete(agentId); }
  authenticate(token: string | undefined): AutomationGrant {
    if (tokensMatch(token, this.token)) return { agentId: 'external' };
    const grant = this.tokens.find(token);
    if (!grant) throw new TeamAuthError('Missing or invalid Waystation MCP token.');
    return { agentId: grant.agentId, cwd: this.scopes.get(grant.agentId), resourcesRunId: this.runScopes.get(grant.agentId) };
  }
  private project(args: Record<string, unknown>, grant: AutomationGrant): { root: string; key: string } {
    const root = folderRoot(args.project ?? grant.cwd);
    if (grant.cwd && folder(root)?.key !== folder(folderRoot(grant.cwd))?.key) throw new LibraryInputError('This agent can access only its own project canvas.');
    return { root, key: folder(root)!.key };
  }
  private reveal(id: string, project: string): { navigation: 'requested' } {
    this.emit('reveal', { id, project, requestId: randomUUID() } satisfies CanvasReveal);
    return { navigation: 'requested' };
  }
  async call(name: unknown, raw: unknown, grant: AutomationGrant, host: { agents: () => readonly Agent[]; consoles: () => readonly ConsoleInfo[] }): Promise<unknown> {
    const spec = this.toolsFor(grant).find(tool => tool.name === name);
    if (!spec) throw new LibraryInputError(`Unknown Waystation tool: ${String(name)}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LibraryInputError('Tool arguments must be an object.');
    const args = raw as Record<string, unknown>;
    if (Object.keys(args).some(key => !Object.hasOwn(spec.inputSchema.properties, key))) throw new LibraryInputError('Unknown tool argument.');
    for (const required of spec.inputSchema.required) if (args[required] === undefined) throw new LibraryInputError(`Missing argument: ${required}`);
    for (const [key, value] of Object.entries(args)) {
      const prop = spec.inputSchema.properties[key as keyof typeof spec.inputSchema.properties] as { type?: string };
      if (prop.type && (prop.type === 'array' ? !Array.isArray(value) : typeof value !== prop.type)) throw new LibraryInputError(`Invalid argument: ${key}`);
    }
    const { root, key } = this.project(args, grant);
    if (grant.resourcesRunId) {
      if (!this.runResources) throw new LibraryInputError('Agent resource runtime is unavailable.');
      return this.runResources.callResource(grant.resourcesRunId, grant.agentId, String(name), args);
    }
    const tiles = this.canvas.list().filter(tile => tile.project === key);
    const requireTile = () => {
      const tile = this.canvas.require(args.id);
      if (tile.project !== key) throw new LibraryInputError('That tile belongs to another project.');
      return tile;
    };
    const metadata = (tile: typeof tiles[number]) => { const { content: _, ...rest } = tile; return rest; };
    switch (name) {
      case 'list_architectures': return { workflows: this.architectures.list().filter(doc => folder(doc.project)?.key === key).map(({ id, title, revision }) => ({ id, title, revision })) };
      case 'get_architecture': return { ...this.architectures.requireProject(args.id, root), capabilities: this.capabilityMetadata?.(root) ?? [], connections: this.store.loadRecords<BrainConnection>('brain_connections')
        .filter(connection => folder(connection.project)?.key === key).map(({ id, label, provider, model }) => ({ id, label, provider, model })) };
      case 'update_architecture': {
        this.architectures.requireProject(args.id, root);
        return this.architectures.update(args.id, args.expectedRevision, args.operations, grant.agentId);
      }
      case 'get_sketch': {
        const snapshot = this.sketches.get(key);
        return { project: key, revision: snapshot.revision, sketch: sketchForAgents(snapshot.doc), summary: planningBrief(snapshot.doc, snapshot.doc.nodes),
          components: SKETCH_LIBRARY.map(({ variant, label, hint, width, height }) => ({ variant, label, hint, width, height })) };
      }
      case 'update_sketch': {
        const { created, revision, doc } = this.sketches.edit(key, args.expectedRevision, args.operations, grant.agentId);
        return { project: key, revision, created, objects: doc.nodes.length, note: 'Open Waystation windows show the change on the console board canvas within a few seconds.' };
      }
      case 'get_workspace': return { project: root, projectKey: key, tiles: tiles.map(metadata),
        agents: host.agents().filter(agent => folder(agent.cwd)?.key === key).map(({ id, name, vendor, status, cwd, currentActivity }) => ({ id, name, vendor, status, cwd, currentActivity })),
        consoles: host.consoles().filter(console => folder(console.cwd)?.key === key), limits: { tiles: 32, noteCharacters: 100_000 } };
      case 'list_tiles': return { tiles: tiles.map(metadata) };
      case 'get_tile': return { tile: requireTile() };
      case 'list_files': return { listing: listFolder(root, args.dir ?? '') };
      case 'close_tile': {
        const tile = requireTile();
        if (args.confirm !== true) throw new LibraryInputError('Closing a tile requires confirm:true.');
        this.canvas.remove(tile.id, grant.agentId); return { closed: tile.id };
      }
      case 'show_tile': { const tile = requireTile(); return this.reveal(tile.id, key); }
      case 'update_tile': {
        const previous = requireTile();
        if (args.content !== undefined && previous.kind !== 'note') throw new LibraryInputError('Only note tiles have content.');
        if (args.url !== undefined && previous.kind !== 'browser') throw new LibraryInputError('Only browser tiles have a URL.');
        const patch = Object.fromEntries(Object.entries(args).filter(([key]) => ['name', 'content', 'url'].includes(key)));
        return { tile: this.canvas.update(previous.id, patch, grant.agentId) };
      }
      default: {
        const kind = name === 'create_note' ? 'note' : name === 'open_file' ? 'file' : name === 'open_preview' ? 'browser' : args.kind;
        const existing = name === 'open_file' ? tiles.find(tile => tile.kind === 'file' && tile.root === root && tile.path === args.path)
          : name === 'open_preview' ? tiles.find(tile => tile.kind === 'browser' && tile.url === args.url) : undefined;
        const tile = existing ?? this.canvas.create({ kind, project: key, name: args.name, content: args.content, url: args.url, root, path: args.path }, grant.agentId);
        return { tile, ...(args.reveal === false ? {} : this.reveal(tile.id, key)) };
      }
    }
  }
}
