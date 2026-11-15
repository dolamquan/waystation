import { useCallback, useEffect, useState } from 'react';
import { api, type SpendCapView } from './api.ts';

const POLL_MS = 60_000;

export interface SpendCapState {
  readonly view?: SpendCapView;
  readonly error?: string;
  readonly refresh: () => Promise<void>;
  readonly replace: (view: SpendCapView) => void;
}

/** The fleet spend cap and today's spend against it, refreshed every minute while enabled. */
export function useSpendCap(enabled: boolean): SpendCapState {
  const [view, setView] = useState<SpendCapView>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setView(await api.spendCap());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { view, error, refresh, replace: setView };
}
