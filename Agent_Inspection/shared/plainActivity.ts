/**
 * Tool-call summaries look like "Bash: npm test" (see describeToolInput). People read
 * "Running npm test" faster, so cards, the station and the activity feed use this wording.
 */

const HELD_PREFIX = /^⏸\s*/;
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/;

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const quoted = (text: string): string => `“${text}”`;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

type Phrase = (arg: string) => string;

const RUN: Phrase = arg => (arg ? `Running ${arg}` : 'Running a command');
const PHRASES: Readonly<Record<string, Phrase>> = {
  Bash: RUN, PowerShell: RUN, exec: RUN, exec_command: RUN, shell: RUN, local_shell: RUN, run_command: RUN,
  Read: arg => (arg ? `Reading ${baseName(arg)}` : 'Reading a file'),
  NotebookRead: arg => (arg ? `Reading ${baseName(arg)}` : 'Reading a notebook'),
  Write: arg => (arg ? `Writing ${baseName(arg)}` : 'Writing a file'),
  Edit: arg => (arg ? `Editing ${baseName(arg)}` : 'Editing a file'),
  MultiEdit: arg => (arg ? `Editing ${baseName(arg)}` : 'Editing a file'),
  NotebookEdit: arg => (arg ? `Editing ${baseName(arg)}` : 'Editing a notebook'),
  apply_patch: arg => {
    const file = PATCH_FILE.exec(arg)?.[1];
    return file ? `Editing ${baseName(file)}` : 'Editing files';
  },
  Grep: arg => (arg ? `Searching for ${quoted(arg)}` : 'Searching files'),
  Glob: arg => (arg ? `Looking for files matching ${arg}` : 'Looking for files'),
  WebSearch: arg => (arg ? `Searching the web for ${quoted(arg)}` : 'Searching the web'),
  web_search: arg => (arg ? `Searching the web for ${quoted(arg)}` : 'Searching the web'),
  WebFetch: arg => {
    const host = hostOf(arg);
    return host ? `Reading a page on ${host}` : 'Reading a web page';
  },
  Task: arg => (arg ? `Handing off: ${arg}` : 'Handing off to a subagent'),
  Agent: arg => (arg ? `Handing off: ${arg}` : 'Handing off to a subagent'),
  spawn_agent: arg => (arg ? `Handing off: ${arg}` : 'Handing off to a subagent'),
  Skill: arg => (arg ? `Using the ${arg} skill` : 'Using a skill'),
  TodoWrite: () => 'Updating its to-do list',
  update_plan: () => 'Updating its plan',
  AskUserQuestion: () => 'Asking you a question',
};

/** "Bash: npm test" → "Running npm test". Unknown tools stay readable rather than disappearing. */
export function plainToolActivity(summary: string): string {
  const held = HELD_PREFIX.test(summary);
  const text = summary.replace(HELD_PREFIX, '').trim();
  const colon = text.indexOf(':');
  const tool = (colon >= 0 ? text.slice(0, colon) : text).trim();
  const arg = colon >= 0 ? text.slice(colon + 1).trim() : '';
  const phrase = describe(tool, arg);
  return held ? `Waiting for approval: ${phrase}` : phrase;
}

function describe(tool: string, arg: string): string {
  if (Object.hasOwn(PHRASES, tool)) return PHRASES[tool](arg);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `Using ${mcp[1]} (${mcp[2].replaceAll('_', ' ')})`;
  if (!arg) return `Using ${tool.replaceAll('_', ' ')}`;
  return `${tool.replaceAll('_', ' ')}: ${arg}`;
}

/** Cards and the station show one short line; replies can be long (the Outputs tab keeps them whole). */
const ACTIVITY_MAX = 280;

/** The sentence to show as an agent's current activity for one event. */
export function activityFromEvent(event: { readonly kind: string; readonly summary: string }): string {
  if (event.kind === 'tool_call') return plainToolActivity(event.summary);
  return event.summary.length > ACTIVITY_MAX ? `${event.summary.slice(0, ACTIVITY_MAX - 1)}…` : event.summary;
}
