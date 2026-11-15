import type { ConsoleKind } from '../../api.ts';

/**
 * What Shift+Enter sends to an agent CLI. xterm.js sends a plain carriage return for Shift+Enter (the same as
 * Enter), so Claude Code and Codex submitted the prompt instead of starting a new line. ESC + CR (Alt+Enter) is the
 * "insert newline" sequence both CLIs accept; verified against Claude Code and Codex in a board console.
 */
export const AGENT_NEWLINE = '\x1b\r';

interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** True for a bare Shift+Enter in an agent console; a shell keeps xterm's default handling. */
export function isAgentShiftEnter(event: KeyLike, kind: ConsoleKind | undefined): boolean {
  return (kind === 'claude' || kind === 'codex')
    && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
