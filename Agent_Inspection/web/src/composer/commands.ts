import type { Agent } from '../api.ts';
import { CLAUDE_CODE_COMMANDS } from '../../../shared/claudeCommands.ts';

/**
 * Slash commands for the message composer:
 * - Claude Code's own commands. Waystation answers the informational ones (/usage, /mcp, /model…) for any Claude
 *   session; the rest run inside agents launched here, or need Claude Code's terminal (offered with /cli).
 * - Waystation's controls (/approve, /stop, /intercept…), the same names as the text console (`npm run attach`).
 */

export type WaystationCommand =
  | 'help' | 'interrupt' | 'stop' | 'approve' | 'deny' | 'ask' | 'intercept'
  | 'rename' | 'delegate' | 'clear-guard' | 'cli';

/** waystation: Waystation acts on the agent · native: Waystation answers a Claude Code command · send: runs in the session · unavailable: needs the terminal */
export type CommandKind = 'waystation' | 'native' | 'send' | 'unavailable';

export interface ComposerCommand {
  readonly name: string;
  readonly description: string;
  /** Shown after the name, e.g. "<reason>"; optional arguments are in brackets. */
  readonly args?: string;
  readonly kind: CommandKind;
  /** Waystation commands that cannot run without an argument. */
  readonly needsArg?: boolean;
  /** Why an unavailable command can't run here. */
  readonly reason?: string;
}

export interface ComposerContext {
  readonly agent: Pick<Agent, 'tier' | 'vendor' | 'status' | 'canInstruct' | 'breaker' | 'inTerminal' | 'sessionId' | 'slashCommands' | 'stopBlockedReason' | 'cwd'>;
  /** A tool call from this agent is waiting for a decision. */
  readonly hasPending: boolean;
  readonly canIntercept: boolean;
  readonly canOpenCli: boolean;
}

export type ComposerAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'send'; readonly text: string }
  | { readonly kind: 'run'; readonly name: WaystationCommand; readonly arg: string }
  | { readonly kind: 'native'; readonly name: string; readonly arg: string }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

interface CommandSpec extends Omit<ComposerCommand, 'name' | 'kind'> {
  readonly name: WaystationCommand;
  readonly when: (ctx: ComposerContext) => boolean;
}

const live = (ctx: ComposerContext) => ctx.agent.status !== 'stopped';

const SPECS: readonly CommandSpec[] = [
  { name: 'help', description: 'Show what you can type here', when: () => true },
  { name: 'approve', description: 'Run the tool call waiting for you', when: ctx => ctx.hasPending },
  { name: 'deny', args: '[reason]', description: 'Skip the waiting tool call, optionally saying why', when: ctx => ctx.hasPending },
  { name: 'ask', description: 'Hand the waiting call to Claude Code’s own prompt', when: ctx => ctx.hasPending && ctx.agent.tier === 'B' },
  { name: 'interrupt', description: 'Stop the current turn; the agent waits for you', when: ctx => live(ctx) && ctx.agent.tier === 'A' },
  { name: 'stop', description: 'End this agent (asks first)', when: ctx => live(ctx) && !ctx.agent.stopBlockedReason },
  { name: 'intercept', args: 'on|off', needsArg: true, description: 'Hold every tool call for your approval', when: ctx => ctx.canIntercept },
  { name: 'rename', args: '<name>', needsArg: true, description: 'Give this agent a new name', when: () => true },
  { name: 'delegate', args: '<task>', needsArg: true, description: 'Start a new agent on a task, with this one’s context', when: ctx => !!ctx.agent.cwd },
  { name: 'clear-guard', description: 'Reset the runaway guard', when: ctx => !!ctx.agent.breaker && ctx.agent.breaker.level !== 'ok' },
  { name: 'cli', description: 'Open this session in the real CLI', when: ctx => ctx.canOpenCli },
];

/** Live SDK controls exist only for Claude agents launched here, while Waystation (not your terminal) runs them. */
const launchedClaude = (ctx: ComposerContext) => ctx.agent.vendor === 'claude' && ctx.agent.tier === 'A' && !ctx.agent.inTerminal && live(ctx);

function unavailableReason(ctx: ComposerContext, terminalOnly: boolean): string {
  const cli = ctx.canOpenCli ? ' Use /cli to open it there.' : '';
  if (ctx.agent.inTerminal) return 'This agent is open in your terminal right now; type it there.';
  if (terminalOnly) return `This needs Claude Code’s own terminal screen.${cli}`;
  return `This runs inside the session, and Waystation can’t type into a session running in your terminal or editor.${cli}`;
}

function claudeCommands(ctx: ComposerContext): ComposerCommand[] {
  const reported = new Map((ctx.agent.slashCommands ?? []).map(command => [command.name.toLowerCase(), command] as const));
  const canRun = launchedClaude(ctx);
  const builtIn = CLAUDE_CODE_COMMANDS.map((command): ComposerCommand => {
    const base = { name: command.name, description: command.description, args: command.args };
    if (command.support === 'native') return { ...base, kind: 'native' };
    // An agent launched here reports what its session can run; trust that over the catalogue.
    if (canRun && (command.support === 'session' || reported.has(command.name))) return { ...base, kind: 'send' };
    return { ...base, kind: 'unavailable', reason: unavailableReason(ctx, command.support === 'terminal') };
  });
  const known = new Set<string>([...CLAUDE_CODE_COMMANDS.map(command => command.name), ...SPECS.map(spec => spec.name), 'mode']);
  const custom = canRun
    ? [...reported.values()].filter(command => !known.has(command.name.toLowerCase())).map((command): ComposerCommand => ({
      name: command.name, description: command.description ?? 'Custom command', args: command.argumentHint, kind: 'send',
    }))
    : [];
  const mode: ComposerCommand[] = canRun ? [{ name: 'mode', args: '[default|acceptEdits|plan]', description: 'Show or switch the permission mode', kind: 'native' }] : [];
  return [...builtIn, ...mode, ...custom];
}

const KIND_ORDER: Readonly<Record<CommandKind, number>> = { native: 1, send: 2, waystation: 3, unavailable: 4 };

export function availableCommands(ctx: ComposerContext): ComposerCommand[] {
  const own = SPECS.filter(spec => spec.when(ctx)).map(({ when: _when, ...spec }): ComposerCommand => ({ ...spec, kind: 'waystation' }));
  const claude = ctx.agent.vendor === 'claude'
    ? claudeCommands(ctx)
    : CLAUDE_CODE_COMMANDS.filter(command => command.support === 'native' && command.anyVendor)
      .map((command): ComposerCommand => ({ name: command.name, description: command.description, args: command.args, kind: 'native' }));
  // A waiting tool call is the most urgent thing to answer, so /approve and /deny lead.
  const urgent = own.filter(command => command.name === 'approve' || command.name === 'deny');
  const rest = [...claude, ...own.filter(command => !urgent.includes(command))];
  return [...urgent, ...rest.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])];
}

/** The partial command name while the menu should be open ("/comp" → "comp"); undefined otherwise. */
export function commandQuery(text: string): string | undefined {
  const match = /^\/(?!\/)([\w:.-]*)$/.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

export function matchCommands(query: string, commands: readonly ComposerCommand[]): ComposerCommand[] {
  const wanted = query.toLowerCase();
  const prefix = commands.filter(command => command.name.toLowerCase().startsWith(wanted));
  const other = commands.filter(command => !prefix.includes(command) && command.name.toLowerCase().includes(wanted));
  return [...prefix, ...other];
}

export function parseComposer(raw: string, commands: readonly ComposerCommand[]): ComposerAction {
  const text = raw.trim();
  if (!text) return { kind: 'none' };
  if (text.startsWith('//')) return { kind: 'send', text: text.slice(1) };
  if (!text.startsWith('/')) return { kind: 'send', text };
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  const name = (match?.[1] ?? '').toLowerCase();
  const arg = (match?.[2] ?? '').trim();
  const command = commands.find(item => item.name.toLowerCase() === name);
  if (!command) {
    return { kind: 'error', message: `/${name} isn’t available for this agent. Type / to see what is, or start with // to send a message that begins with “/”.` };
  }
  switch (command.kind) {
    case 'send': return { kind: 'send', text };
    case 'native': return { kind: 'native', name: command.name, arg };
    case 'unavailable': return { kind: 'unavailable', message: `/${command.name}: ${command.reason ?? 'not available here.'}` };
    case 'waystation':
      if (command.needsArg && !arg) return { kind: 'error', message: `/${command.name} needs ${command.args ?? 'an argument'}.` };
      if (command.name === 'intercept' && !/^(on|off)$/i.test(arg)) return { kind: 'error', message: 'Use /intercept on or off.' };
      return { kind: 'run', name: command.name as WaystationCommand, arg: command.name === 'intercept' ? arg.toLowerCase() : arg };
  }
}

const SPOKEN_SLASH = /^\s*(?:forward\s+)?slash\s+/i;
const SPOKEN_SEND = /[\s,.;:!?]*\b(?:send it|send message|send now)[\s.!?]*$/i;

/** "slash compact" → "/compact"; a closing "send it" asks the composer to submit. */
export function parseSpoken(transcript: string): { readonly text: string; readonly send: boolean } {
  const send = SPOKEN_SEND.test(transcript);
  const spoken = (send ? transcript.replace(SPOKEN_SEND, '') : transcript).trim();
  if (!SPOKEN_SLASH.test(spoken)) return { text: spoken, send };
  const [first = '', ...rest] = spoken.replace(SPOKEN_SLASH, '').split(/\s+/);
  return { text: [`/${first.toLowerCase()}`, ...rest].join(' ').trim(), send };
}

export function appendDictation(current: string, piece: string): string {
  if (!piece) return current;
  if (!current || /\s$/.test(current)) return current + piece;
  return `${current} ${piece}`;
}
