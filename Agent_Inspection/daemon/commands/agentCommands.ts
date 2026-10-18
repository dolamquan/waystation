import type { Agent } from '../domain/types.ts';
import type { UsageWindowsReport, VendorWindows } from '../usage/windowTypes.ts';
import { isValidModelName } from '../managed/modelName.ts';
import {
  SWITCHABLE_MODES, isNativeCommand, type CommandResult, type CommandRow, type CommandSection,
} from '../../shared/claudeCommands.ts';
import { agentDefinitions, configuredMcpServers, memoryFiles } from './claudeConfig.ts';
import { CommandError, type ClaudeControl } from './types.ts';

/**
 * Claude Code's informational commands (/usage, /mcp, /model…) answered by Waystation, plus live changes for
 * agents it launched. Sessions running elsewhere get honest read-only answers: Waystation cannot type into them.
 */

export interface CommandDeps {
  readonly agent: (id: string) => Agent | undefined;
  /** Present only for Claude agents launched from Waystation. */
  readonly control: (id: string) => ClaudeControl | undefined;
  readonly usageWindows: () => Promise<UsageWindowsReport>;
  /** Restart & continue on another model (Codex agents launched here). */
  readonly restartWithModel: (id: string, model: string) => Promise<unknown>;
  readonly claudeHome: string;
  /** ~/.claude.json */
  readonly userConfigFile: string;
  readonly audit: (action: string, target: string, detail: unknown) => void;
  readonly now?: () => number;
}

const MAX_ARG = 200;
const OUTSIDE_NOTE = 'This session runs outside Waystation, so Waystation shows what it can see but cannot change it. /cli opens it in the real CLI.';

export async function runAgentCommand(deps: CommandDeps, agentId: string, rawName: unknown, rawArg: unknown): Promise<CommandResult> {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase().replace(/^\//, '') : '';
  const arg = typeof rawArg === 'string' ? rawArg.trim() : '';
  if (arg.length > MAX_ARG) throw new CommandError('That argument is too long.');
  const agent = deps.agent(agentId);
  if (!agent) throw new CommandError('Agent not found (it may have exited).');
  const control = agent.vendor === 'claude' ? deps.control(agentId) : undefined;
  if (name === 'mode') return mode(deps, agent, control, arg);
  if (!isNativeCommand(name)) throw new CommandError(`/${name} is not a command Waystation answers.`);
  if (agent.vendor !== 'claude' && ['mcp', 'memory', 'agents'].includes(name)) throw new CommandError(`/${name} is a Claude Code command.`);
  switch (name) {
    case 'usage': return usage(deps, agent);
    case 'cost': return cost(agent);
    case 'context': return context(agent, control);
    case 'status': return status(agent, control);
    case 'model': return model(deps, agent, control, arg);
    case 'mcp': return mcp(deps, agent, control, arg);
    case 'memory': return memory(deps, agent);
    case 'agents': return agents(deps, agent, control);
  }
}

// ── formatting ──────────────────────────────────────────────────────────────

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function untilText(ts: number | undefined, now: number): string | undefined {
  if (ts === undefined) return undefined;
  const minutes = Math.max(0, Math.round((ts - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const usd = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
const toneFor = (percent: number): CommandRow['tone'] => (percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'ok');
const VENDOR_NAME = { claude: 'Claude', codex: 'Codex' } as const;

// ── /usage, /cost, /context, /status ───────────────────────────────────────

function sessionRows(agent: Agent): CommandRow[] {
  const usage = agent.usage;
  if (!usage) return [{ label: 'This session', value: 'No usage recorded yet', tone: 'muted' }];
  const t = usage.tokens;
  const total = t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return [
    { label: 'Tokens', value: compactNumber(total), detail: `${compactNumber(t.input)} in · ${compactNumber(t.output)} out · ${compactNumber(t.cacheRead)} cache read · ${compactNumber(t.cacheWrite5m + t.cacheWrite1h)} cache write` },
    { label: 'Estimated cost', value: usd(usage.costUsd) ?? 'No list price for this model', tone: usage.costUsd === undefined ? 'muted' : undefined },
  ];
}

function limitRows(vendor: VendorWindows, now: number): CommandRow[] {
  const real = vendor.limits.map((limit): CommandRow => ({
    label: `${limit.label} window`,
    value: limit.usedPercent === undefined ? (limit.status === 'rejected' ? 'Limit reached' : 'No percentage reported') : `${Math.round(limit.usedPercent)}% used`,
    meter: limit.usedPercent,
    tone: limit.status === 'rejected' ? 'bad' : limit.usedPercent === undefined ? 'muted' : toneFor(limit.usedPercent),
    detail: untilText(limit.resetsAt, now),
  }));
  const block = vendor.block;
  const estimate: CommandRow = block
    ? { label: 'Current 5-hour block (estimate)', value: `${compactNumber(block.totalTokens)} tokens`, detail: [usd(block.costUsd), untilText(block.end, now)].filter(Boolean).join(' · ') }
    : { label: 'Current 5-hour block (estimate)', value: 'No activity in the last 5 hours', tone: 'muted' };
  const week: CommandRow = { label: 'Last 7 days (estimate)', value: `${compactNumber(vendor.week.totalTokens)} tokens`, detail: usd(vendor.week.costUsd) };
  const none: CommandRow = { label: 'Plan limits', value: 'No live reading on this machine yet', tone: 'muted' };
  return [...(real.length ? real : [none]), estimate, week];
}

async function usage(deps: CommandDeps, agent: Agent): Promise<CommandResult> {
  const now = deps.now?.() ?? Date.now();
  const report = await deps.usageWindows().catch(() => undefined);
  const vendor = report?.vendors.find((v) => v.vendor === agent.vendor);
  const sections: CommandSection[] = [
    ...(vendor ? [{ heading: `${VENDOR_NAME[vendor.vendor]} plan${vendor.planType ? ` (${vendor.planType})` : ''}`, rows: limitRows(vendor, now) }] : []),
    { heading: 'This session', rows: sessionRows(agent) },
  ];
  return {
    title: 'Usage',
    sections,
    note: 'Percentages are reported by Claude or Codex. Token counts and costs are estimates from this machine’s transcripts at list prices.',
  };
}

function cost(agent: Agent): CommandResult {
  return { title: 'Cost', sections: [{ rows: sessionRows(agent) }], note: 'List-price estimate; subscription plans are billed differently.' };
}

async function context(agent: Agent, control: ClaudeControl | undefined): Promise<CommandResult> {
  if (control) {
    const usage = await control.contextUsage();
    return {
      title: 'Context',
      sections: [
        { rows: [{ label: 'Used', value: `${compactNumber(usage.totalTokens)} of ${compactNumber(usage.maxTokens)} tokens`, meter: usage.percentage, tone: toneFor(usage.percentage), detail: `${Math.round(usage.percentage)}%` }] },
        { heading: 'What fills it', rows: usage.categories.map((c) => ({ label: c.name, value: compactNumber(c.tokens) })) },
      ],
    };
  }
  const used = agent.usage?.contextTokens;
  const window = agent.usage?.contextWindow;
  if (used === undefined || !window) return { title: 'Context', sections: [{ rows: [{ label: 'Used', value: 'Not recorded yet', tone: 'muted' }] }] };
  const percent = Math.min(100, (used / window) * 100);
  return {
    title: 'Context',
    sections: [{ rows: [{ label: 'Used', value: `${compactNumber(used)} of ${compactNumber(window)} tokens`, meter: percent, tone: toneFor(percent), detail: `${Math.round(percent)}%, as of the last request` }] }],
  };
}

function controlLabel(agent: Agent): string {
  if (agent.tier === 'A') return 'Launched in Waystation';
  if (agent.tier === 'B') return agent.hooked ? 'Your Claude Code session, connected through hooks' : 'Your Claude Code session';
  return 'Observed only';
}

async function status(agent: Agent, control: ClaudeControl | undefined): Promise<CommandResult> {
  const account = control ? await control.account().catch(() => undefined) : undefined;
  const optional = (show: unknown, row: CommandRow): CommandRow[] => (show ? [row] : []);
  const rows: CommandRow[] = [
    { label: 'Model', value: control?.currentModel ?? agent.model ?? 'Not reported yet' },
    { label: 'Folder', value: agent.cwd ?? agent.project },
    { label: 'Session', value: agent.sessionId ?? 'Not started yet' },
    { label: 'Control', value: controlLabel(agent) },
    ...optional(control?.mode, { label: 'Permission mode', value: control?.mode, actions: SWITCHABLE_MODES.filter((m) => m !== control?.mode).map((m) => ({ label: m, command: `/mode ${m}` })) }),
    ...optional(agent.intercepting, { label: 'Intercept', value: 'On: tool calls wait for you', tone: 'warn' }),
    ...optional(control?.version, { label: 'Claude Code', value: control?.version }),
    ...optional(account?.subscriptionType, { label: 'Plan', value: account?.subscriptionType }),
    ...optional(account?.organization, { label: 'Organization', value: account?.organization }),
  ];
  return { title: 'Status', sections: [{ rows }] };
}

// ── /model ─────────────────────────────────────────────────────────────────

async function switchModel(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined, wanted: string): Promise<CommandResult> {
  if (!isValidModelName(wanted)) throw new CommandError('That doesn’t look like a model name.');
  if (control) {
    await control.setModel(wanted);
    deps.audit('set_model', agent.id, { model: wanted });
    return { title: 'Model', sections: [{ rows: [{ label: 'Now using', value: wanted, tone: 'ok' }] }], done: `Switched to ${wanted}` };
  }
  if (agent.tier === 'A' && agent.vendor === 'codex' && !agent.inTerminal) {
    await deps.restartWithModel(agent.id, wanted);
    return { title: 'Model', sections: [{ rows: [{ label: 'Restarted on', value: wanted, tone: 'ok' }] }], done: `Restarted on ${wanted}` };
  }
  throw new CommandError('Waystation can’t switch the model of a session running outside it. Use /cli to open it in the real CLI, where /model works.');
}

async function model(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined, arg: string): Promise<CommandResult> {
  if (arg) return switchModel(deps, agent, control, arg);
  const current = control?.currentModel ?? agent.model;
  if (!control) {
    return { title: 'Model', sections: [{ rows: [{ label: 'Current model', value: current ?? 'Not reported yet' }] }], note: agent.tier === 'A' ? 'Type /model <name> to restart on another model.' : OUTSIDE_NOTE };
  }
  const models = await control.models();
  return {
    title: 'Model',
    sections: [
      { rows: [{ label: 'Current model', value: current ?? 'Default' }] },
      { heading: 'Switch to', rows: models.map((m): CommandRow => ({ label: m.displayName, detail: m.description, tone: m.value === current ? 'ok' : undefined, actions: m.value === current ? [] : [{ label: 'Use', command: `/model ${m.value}` }] })) },
    ],
    note: 'Switching takes effect from the next request, without restarting the agent.',
  };
}

// ── /mcp ───────────────────────────────────────────────────────────────────

const MCP_TONE: Readonly<Record<string, CommandRow['tone']>> = { connected: 'ok', pending: 'muted', disabled: 'muted', failed: 'bad', 'needs-auth': 'warn' };

async function mcpList(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined): Promise<CommandResult> {
  if (control) {
    const servers = await control.mcpStatus();
    const rows = servers.map((s): CommandRow => ({
      label: s.name,
      value: s.status,
      tone: MCP_TONE[s.status],
      detail: [s.scope, s.error].filter(Boolean).join(' · ') || undefined,
      actions: s.status === 'disabled'
        ? [{ label: 'Enable', command: `/mcp enable ${s.name}` }]
        : [{ label: 'Reconnect', command: `/mcp reconnect ${s.name}` }, { label: 'Disable', command: `/mcp disable ${s.name}` }],
    }));
    return { title: 'MCP servers', sections: [{ rows: rows.length ? rows : [{ label: 'No MCP servers', tone: 'muted' }] }] };
  }
  const servers = await configuredMcpServers(deps.userConfigFile, agent.cwd);
  const rows = servers.map((s): CommandRow => ({ label: s.name, value: s.transport, detail: `${s.scope} scope` }));
  return {
    title: 'MCP servers',
    sections: [{ heading: 'Configured', rows: rows.length ? rows : [{ label: 'No MCP servers configured', tone: 'muted' }] }],
    note: `Live connection status is only known inside the session, and plugin servers aren’t listed. ${OUTSIDE_NOTE}`,
  };
}

async function mcp(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined, arg: string): Promise<CommandResult> {
  const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (!verb) return mcpList(deps, agent, control);
  const action = verb.toLowerCase();
  const server = rest.join(' ');
  if (!['reconnect', 'enable', 'disable'].includes(action)) throw new CommandError('Use /mcp, or /mcp reconnect|enable|disable <server>.');
  if (!server) throw new CommandError(`Name a server, for example /mcp ${action} github.`);
  if (!control) throw new CommandError(`Waystation can’t change MCP servers in a session running outside it. ${OUTSIDE_NOTE}`);
  if (!(await control.mcpStatus()).some((s) => s.name === server)) throw new CommandError(`No MCP server named “${server}”.`);
  if (action === 'reconnect') await control.mcpReconnect(server);
  else await control.mcpToggle(server, action === 'enable');
  deps.audit(`mcp_${action}`, agent.id, { server });
  const done = action === 'reconnect' ? `Reconnecting ${server}` : `${action === 'enable' ? 'Enabled' : 'Disabled'} ${server}`;
  return { ...await mcpList(deps, agent, control), done };
}

// ── /memory, /agents, /mode ────────────────────────────────────────────────

async function memory(deps: CommandDeps, agent: Agent): Promise<CommandResult> {
  const now = deps.now?.() ?? Date.now();
  const files = await memoryFiles(deps.claudeHome, agent.cwd);
  const edited = (ts: number) => {
    const hours = Math.round((now - ts) / 3_600_000);
    return hours < 1 ? 'edited within the hour' : hours < 48 ? `edited ${hours}h ago` : `edited ${Math.round(hours / 24)}d ago`;
  };
  const rows = files.map((f): CommandRow => ({ label: f.label, value: f.path, detail: `${compactNumber(f.bytes)} bytes · ${edited(f.modifiedAt)}` }));
  return {
    title: 'Memory',
    sections: [{ rows: rows.length ? rows : [{ label: 'No CLAUDE.md files for this folder', tone: 'muted' }] }],
    note: 'Edit these files to change what Claude remembers; /init writes a project one.',
  };
}

async function agents(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined): Promise<CommandResult> {
  if (control) {
    const types = await control.agentTypes();
    return { title: 'Subagents', sections: [{ rows: types.map((t) => ({ label: t.name, detail: t.description })) }] };
  }
  const defined = await agentDefinitions(deps.claudeHome, agent.cwd);
  const rows = defined.map((d): CommandRow => ({ label: d.name, detail: `${d.scope} agent` }));
  return {
    title: 'Subagents',
    sections: [{ heading: 'Defined in files', rows: rows.length ? rows : [{ label: 'No custom subagents', tone: 'muted' }] }],
    note: 'Built-in subagents (general-purpose, Explore, Plan…) are always available too.',
  };
}

async function mode(deps: CommandDeps, agent: Agent, control: ClaudeControl | undefined, arg: string): Promise<CommandResult> {
  if (!control) throw new CommandError(agent.tier === 'A' ? 'Permission modes can only be changed for Claude agents.' : `Permission modes can only be changed for agents launched in Waystation. ${OUTSIDE_NOTE}`);
  if (!arg) {
    const rows = SWITCHABLE_MODES.map((m): CommandRow => ({ label: m, tone: m === control.mode ? 'ok' : undefined, value: m === control.mode ? 'current' : undefined, actions: m === control.mode ? [] : [{ label: 'Use', command: `/mode ${m}` }] }));
    return { title: 'Permission mode', sections: [{ rows }] };
  }
  const wanted = SWITCHABLE_MODES.find((m) => m.toLowerCase() === arg.toLowerCase());
  if (!wanted) throw new CommandError(`Use /mode ${SWITCHABLE_MODES.join(', /mode ')}.`);
  await control.setPermissionMode(wanted);
  deps.audit('set_permission_mode', agent.id, { mode: wanted });
  return { title: 'Permission mode', sections: [{ rows: [{ label: 'Now', value: wanted, tone: 'ok' }] }], done: `Permission mode: ${wanted}` };
}
