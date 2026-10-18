/** Pure parsing for the attach console: argv, typed lines, and target lookup. */

type ApprovalCommand = { readonly kind: 'approve' } | { readonly kind: 'deny'; readonly message?: string } | { readonly kind: 'ask' };
type CommonCommand =
  | ApprovalCommand
  | { readonly kind: 'help' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string };

export type AgentCommand =
  | CommonCommand
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'intercept'; readonly on: boolean };

export type TeamCommand =
  | CommonCommand
  | { readonly kind: 'say'; readonly to: string; readonly text: string }
  | { readonly kind: 'tasks' }
  | { readonly kind: 'members' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'diff'; readonly member: string; readonly full: boolean }
  | { readonly kind: 'merge'; readonly member: string }
  | { readonly kind: 'attach'; readonly member: string }
  | { readonly kind: 'filter'; readonly everything: boolean };

export const EVERYONE = 'all';

export const AGENT_HELP: readonly string[] = [
  'Type a message and press Enter to send it to this agent.',
  '  /interrupt            stop the current turn (agents launched from Waystation)',
  '  /stop                 end the agent (asks first)',
  '  /approve              run the tool call waiting for you',
  '  /deny [reason]        skip it, optionally telling the agent why',
  '  /ask                  hand it to Claude Code\'s own permission prompt',
  '  /intercept on|off     hold every tool call for your approval',
  '  //text                send a message that starts with "/"',
  '  /help   /quit',
];

export const TEAM_HELP: readonly string[] = [
  'Type a message to send it to everyone, or start with @name to message one member.',
  '  @name <message>       message one member (@all for everyone)',
  '  /tasks   /members     show the task board or the roster',
  '  /pause   /resume      pause the team, or resume it with more budget',
  '  /diff <member> [full] show a member\'s changes (full prints the patch)',
  '  /merge <member>       merge a member\'s branch into the base branch (asks first)',
  '  /attach <member>      open that member\'s own console in a new tab',
  '  /approve  /deny [reason]  /ask   answer a member\'s held tool call',
  '  /filter channel|everything       hide or show member tool activity',
  '  /help   /quit',
];

interface Slash { readonly name: string; readonly rest: string }

/** `/name rest` → { name, rest }; anything else (including `//text`) → undefined. */
function slash(line: string): Slash | undefined {
  if (!line.startsWith('/') || line.startsWith('//')) return undefined;
  const [name, ...rest] = line.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), rest: rest.join(' ').trim() };
}

const unescape = (line: string) => (line.startsWith('//') ? line.slice(1) : line);
const unknown = (name: string): CommonCommand => ({ kind: 'error', message: `Unknown command "/${name}". Type /help to see what you can do.` });
const memberArg = (rest: string) => rest.split(/\s+/)[0]?.replace(/^@/, '').toLowerCase() ?? '';

function common(command: Slash): CommonCommand | undefined {
  switch (command.name) {
    case 'approve': return { kind: 'approve' };
    case 'deny': return { kind: 'deny', message: command.rest || undefined };
    case 'ask': return { kind: 'ask' };
    case 'help': case '?': return { kind: 'help' };
    case 'quit': case 'exit': case 'q': return { kind: 'quit' };
    default: return undefined;
  }
}

export function parseAgentLine(raw: string): AgentCommand {
  const line = raw.trim();
  if (!line) return { kind: 'none' };
  const command = slash(line);
  if (!command) return { kind: 'say', text: unescape(line) };
  const shared = common(command);
  if (shared) return shared;
  switch (command.name) {
    case 'interrupt': return { kind: 'interrupt' };
    case 'stop': return { kind: 'stop' };
    case 'intercept': {
      const value = command.rest.toLowerCase();
      if (value === 'on' || value === 'off') return { kind: 'intercept', on: value === 'on' };
      return { kind: 'error', message: 'Use /intercept on or /intercept off.' };
    }
    default: return unknown(command.name);
  }
}

function parseMention(line: string): TeamCommand {
  const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(line);
  if (!match) return { kind: 'error', message: 'Write @name followed by your message.' };
  const [, name, text] = match;
  if (!text.trim()) return { kind: 'error', message: `Add a message after @${name}.` };
  return { kind: 'say', to: name.toLowerCase(), text: text.trim() };
}

function teamSlash(command: Slash): TeamCommand {
  const member = memberArg(command.rest);
  const needsMember = (kind: 'diff' | 'merge' | 'attach'): TeamCommand =>
    ({ kind: 'error', message: `Name a member, for example /${kind} mica.` });
  switch (command.name) {
    case 'tasks': return { kind: 'tasks' };
    case 'members': return { kind: 'members' };
    case 'pause': return { kind: 'pause' };
    case 'resume': return { kind: 'resume' };
    case 'diff': return member ? { kind: 'diff', member, full: /\bfull$/i.test(command.rest) } : needsMember('diff');
    case 'merge': return member ? { kind: 'merge', member } : needsMember('merge');
    case 'attach': return member ? { kind: 'attach', member } : needsMember('attach');
    case 'filter': {
      const value = command.rest.toLowerCase();
      if (value === 'everything' || value === 'all') return { kind: 'filter', everything: true };
      if (value === 'channel') return { kind: 'filter', everything: false };
      return { kind: 'error', message: 'Use /filter channel or /filter everything.' };
    }
    default: return common(command) ?? unknown(command.name);
  }
}

export function parseTeamLine(raw: string): TeamCommand {
  const line = raw.trim();
  if (!line) return { kind: 'none' };
  if (line.startsWith('@')) return parseMention(line);
  const command = slash(line);
  return command ? teamSlash(command) : { kind: 'say', to: EVERYONE, text: unescape(line) };
}

export interface AttachArgs {
  readonly kind?: 'agent' | 'team';
  readonly query?: string;
  readonly home?: string;
  readonly everything: boolean;
}

export function parseAttachArgs(argv: readonly string[]): AttachArgs | { readonly error: string } {
  const positional: string[] = [];
  let home: string | undefined;
  let everything = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') everything = true;
    else if (arg === '--home') {
      home = argv[i + 1];
      if (!home) return { error: '--home needs a folder.' };
      i += 1;
    } else positional.push(arg);
  }
  const [kind, ...rest] = positional;
  const base = { ...(home ? { home } : {}), everything };
  if (!kind) return base;
  if (kind !== 'agent' && kind !== 'team') return { error: `Unknown mode "${kind}". Use agent or team.` };
  const query = rest.join(' ').trim();
  if (!query) return { error: `Say which ${kind} to attach to, by id or name.` };
  return { kind, query, ...base };
}

interface Named { readonly id: string; readonly name: string }

/** Exact id, then exact name, then a unique fragment of either (all case-insensitive). */
export function findTarget<T extends Named>(items: readonly T[], query: string): { match?: T; error?: string } {
  const wanted = query.trim().toLowerCase();
  const exact = items.find((item) => item.id.toLowerCase() === wanted) ?? items.find((item) => item.name.toLowerCase() === wanted);
  if (exact) return { match: exact };
  const partial = items.filter((item) => item.id.toLowerCase().includes(wanted) || item.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length === 0) return { error: `No match for "${query}".` };
  const options = partial.slice(0, 6).map((item) => `  ${item.id}  ${item.name}`).join('\n');
  return { error: `"${query}" matches more than one:\n${options}\nUse the full id.` };
}
