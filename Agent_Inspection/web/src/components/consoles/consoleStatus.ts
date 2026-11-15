import type { ConsoleInfo } from '../../api.ts';
import './attention.css';

/** A console that printed within this window counts as working. */
export const WORKING_WINDOW_MS = 3000;

export type Status = 'working' | 'idle' | 'needs-you' | 'ready' | 'exited';

const LABELS: Readonly<Record<Status, string>> = {
  working: 'working',
  idle: 'idle',
  'needs-you': 'needs you',
  ready: 'ready',
  exited: 'exited',
};

/** What the board shows for a console right now: the CLI's own hooks when linked, else how recently it printed. */
export const statusOf = (info: ConsoleInfo, now: number): Status => {
  if (info.state === 'exited') return 'exited';
  if (info.attention) return info.attention;
  return now - info.lastOutputAt < WORKING_WINDOW_MS ? 'working' : 'idle';
};

/** Human text for a status; the CSS class keeps the hyphenated id. */
export const statusLabel = (status: Status): string => LABELS[status];

/** Running consoles waiting on the operator, for the badge on the nav entry. */
export const needsYouCount = (consoles: readonly ConsoleInfo[]): number =>
  consoles.filter((info) => info.state === 'running' && info.attention === 'needs-you').length;
