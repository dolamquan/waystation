/**
 * Claude Code's built-in slash commands, and how Waystation can honour each one from outside the terminal.
 *
 * - native:   Waystation answers it itself (any Claude session; a few also for Codex), and can act on agents it launched.
 * - session:  runs inside a session Waystation launched, sent as typed (the Agent SDK executes it).
 * - terminal: needs Claude Code's own terminal UI; Waystation offers to open the session there.
 *
 * Agents launched here also report their own list (custom, plugin and project commands), which wins over this one.
 */

export type CommandSupport = 'native' | 'session' | 'terminal';

export interface ClaudeCommand {
  readonly name: string;
  readonly description: string;
  readonly args?: string;
  readonly support: CommandSupport;
  /** Native commands that also work for Codex agents. */
  readonly anyVendor?: boolean;
}

export const NATIVE_COMMANDS = ['usage', 'cost', 'context', 'status', 'mcp', 'model', 'memory', 'agents'] as const;
export type NativeCommand = typeof NATIVE_COMMANDS[number];

export const CLAUDE_CODE_COMMANDS: readonly ClaudeCommand[] = [
  { name: 'usage', description: 'Plan limits (5-hour and weekly) and this session’s usage', support: 'native', anyVendor: true },
  { name: 'cost', description: 'Tokens and estimated cost of this session', support: 'native', anyVendor: true },
  { name: 'context', description: 'How full the context window is', support: 'native', anyVendor: true },
  { name: 'status', description: 'Model, folder, session and account details', support: 'native', anyVendor: true },
  { name: 'model', args: '[model]', description: 'Show the model, or switch it', support: 'native', anyVendor: true },
  { name: 'mcp', args: '[reconnect|enable|disable <server>]', description: 'MCP servers and their status', support: 'native' },
  { name: 'memory', description: 'The CLAUDE.md memory files this session reads', support: 'native' },
  { name: 'agents', description: 'Subagents this session can use', support: 'native' },
  { name: 'compact', args: '[instructions]', description: 'Clear history but keep a summary in context', support: 'session' },
  { name: 'clear', description: 'Clear the conversation history', support: 'session' },
  { name: 'review', args: '[pr]', description: 'Review a pull request', support: 'session' },
  { name: 'security-review', description: 'Security review of the pending changes', support: 'session' },
  { name: 'pr-comments', args: '[pr]', description: 'Fetch comments from a pull request', support: 'session' },
  { name: 'init', description: 'Write a CLAUDE.md guide for this project', support: 'session' },
  { name: 'add-dir', args: '<path>', description: 'Add another working directory', support: 'session' },
  { name: 'todos', description: 'List the current to-do items', support: 'session' },
  { name: 'export', description: 'Export the conversation', support: 'session' },
  { name: 'release-notes', description: 'Claude Code release notes', support: 'session' },
  { name: 'config', description: 'Open Claude Code settings', support: 'terminal' },
  { name: 'permissions', description: 'Edit allow and deny rules', support: 'terminal' },
  { name: 'hooks', description: 'Manage hook configuration', support: 'terminal' },
  { name: 'plugin', description: 'Manage plugins', support: 'terminal' },
  { name: 'resume', description: 'Resume another conversation', support: 'terminal' },
  { name: 'rewind', description: 'Rewind the conversation or code', support: 'terminal' },
  { name: 'output-style', description: 'Change the output style', support: 'terminal' },
  { name: 'doctor', description: 'Check the Claude Code installation', support: 'terminal' },
  { name: 'login', description: 'Sign in to an Anthropic account', support: 'terminal' },
  { name: 'logout', description: 'Sign out', support: 'terminal' },
  { name: 'ide', description: 'Connect to an IDE', support: 'terminal' },
  { name: 'statusline', description: 'Set up the status line', support: 'terminal' },
  { name: 'terminal-setup', description: 'Set up terminal key bindings', support: 'terminal' },
  { name: 'vim', description: 'Toggle vim editing mode', support: 'terminal' },
  { name: 'install-github-app', description: 'Set up the Claude GitHub app', support: 'terminal' },
  { name: 'bug', description: 'Report a bug to Anthropic', support: 'terminal' },
  { name: 'exit', description: 'Leave Claude Code', support: 'terminal' },
];

export const isNativeCommand = (name: string): name is NativeCommand => (NATIVE_COMMANDS as readonly string[]).includes(name);

/** Permission modes the operator can switch an agent launched here into (bypass modes stay out of reach). */
export const SWITCHABLE_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type SwitchableMode = typeof SWITCHABLE_MODES[number];

/** What a native command returns: a small, uniform panel the composer renders. */
export interface CommandRow {
  readonly label: string;
  readonly value?: string;
  readonly detail?: string;
  readonly tone?: 'ok' | 'warn' | 'bad' | 'muted';
  /** Percent bar, 0-100. */
  readonly meter?: number;
  /** Each action runs another command, e.g. "/model claude-sonnet-5-5". */
  readonly actions?: readonly { readonly label: string; readonly command: string }[];
}

export interface CommandSection {
  readonly heading?: string;
  readonly rows: readonly CommandRow[];
}

export interface CommandResult {
  readonly title: string;
  readonly sections: readonly CommandSection[];
  readonly note?: string;
  /** Shown as a toast after a change (switching model, toggling a server…). */
  readonly done?: string;
}
