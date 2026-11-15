import { useCallback, useEffect, useState } from 'react';
import type { FactorySnapshot } from '../../../../shared/factory.ts';
import { factoryApi } from './api.ts';
export function useFactory(enabled: boolean) {
  const [data, setData] = useState<FactorySnapshot>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try { setData(await factoryApi.snapshot()); setError(undefined); }
    catch (error) { setError((error as Error).message); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false; let loading = false;
    const poll = async () => {
      if (loading) return; loading = true;
      try { const next = await factoryApi.snapshot(); if (!stopped) { setData(next); setError(undefined); } }
      catch (error) { if (!stopped) setError((error as Error).message); } finally { loading = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [enabled]);
  return { data, error, refresh };
}
