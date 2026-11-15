import { api, type ConsoleInfo } from '../../api.ts';
import type { BoardItem } from './boardItems.ts';

type Notify = (text: string, kind?: 'ok' | 'error') => void;

/** Consoles an agent CLI runs in (Claude Code or Codex) that are still running: the ones Pause, Resume and handoffs reach. */
export const agentConsoles = (items: readonly BoardItem[]): readonly ConsoleInfo[] =>
  items.flatMap((item) => (item.console && item.console.kind !== 'shell' && item.console.state === 'running' ? [item.console] : []));

const VERB = { pause: 'Paused', resume: 'Resumed' } as const;

/**
 * Pause (Esc, which interrupts the current turn) or resume ("continue") every agent console given.
 * Reports one summary, naming any that failed rather than hiding them.
 */
export async function sendTeamKeys(consoles: readonly ConsoleInfo[], action: 'pause' | 'resume', notify: Notify): Promise<void> {
  if (consoles.length === 0) { notify('No running Claude Code or Codex consoles here.', 'error'); return; }
  const results = await Promise.allSettled(consoles.map((info) => api.consoleKeys(info.id, action)));
  const failed = consoles.filter((_, index) => results[index]!.status === 'rejected').map((info) => info.name);
  const sent = results.length - failed.length;
  if (failed.length === 0) notify(`${VERB[action]} ${sent} console${sent === 1 ? '' : 's'}`);
  else notify(`${VERB[action]} ${sent}; could not reach ${failed.join(', ')}`, 'error');
}
