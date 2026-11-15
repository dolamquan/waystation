import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { needsYouCount } from './consoleStatus.ts';

const POLL_MS = 4000;

/** How many consoles are waiting on the operator, kept fresh while any view is open so the nav badge never goes stale. */
export function useNeedsYou(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const { consoles } = await api.consoles();
        if (!cancelled) setCount(needsYouCount(consoles));
      } catch {
        // A badge is not worth an error toast: the board itself reports an unreachable daemon.
        if (!cancelled) setCount(0);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled]);
  return count;
}
