import { useEffect, useSyncExternalStore } from 'react';
import { MANAGED_PROVIDERS, replaceProviderCatalog, type ProviderDescriptor } from '../../shared/agentProviders.ts';
import { request } from './api.ts';

interface ProviderState { readonly providers: readonly ProviderDescriptor[]; readonly warnings: readonly string[]; readonly configFile?: string; readonly error?: string }
let state: ProviderState = { providers: [...MANAGED_PROVIDERS], warnings: [] };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let loading: Promise<void> | undefined;
export function refreshProviders(): Promise<void> {
  if (loading) return loading;
  loading = request<ProviderState>('GET', '/api/providers').then(result => {
    if (!Array.isArray(result.providers)) throw new Error('Provider configuration is unavailable.');
    const next = { providers: result.providers, warnings: result.warnings ?? [], configFile: result.configFile };
    if (JSON.stringify(state) !== JSON.stringify(next)) {
      replaceProviderCatalog(next.providers); state = next; listeners.forEach(listener => listener());
    }
  }, error => { state = { ...state, error: error.message }; listeners.forEach(listener => listener()); }).catch(error => {
    state = { ...state, error: error.message }; listeners.forEach(listener => listener());
  }).finally(() => { loading = undefined; });
  return loading;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refreshProviders(); timer = setInterval(() => { void refreshProviders(); }, 10_000);
    window.addEventListener('waystation:providers-changed', reload);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; window.removeEventListener('waystation:providers-changed', reload); }
  };
}
const reload = () => { void refreshProviders(); };
/** All surfaces subscribe to one live daemon catalog, including runtime-installed ACP adapters. */
export function useProviders() {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => { void refreshProviders(); }, []);
  return snapshot;
}
