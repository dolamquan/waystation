import { useCallback, useState } from 'react';
import type { StationOffice } from './stationOffices.ts';

/** Which working-folder tabs the person has closed in the Station strip. */
const STORAGE_KEY = 'waystation.closedOffices';

export function parseClosedOffices(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0))];
  } catch {
    return [];
  }
}

export function splitOffices(offices: readonly StationOffice[], closedKeys: readonly string[]): { open: StationOffice[]; closed: StationOffice[] } {
  const closedSet = new Set(closedKeys);
  return {
    open: offices.filter(office => !closedSet.has(office.key)),
    closed: offices.filter(office => closedSet.has(office.key)),
  };
}

export const closeOffice = (closedKeys: readonly string[], key: string): readonly string[] =>
  closedKeys.includes(key) ? closedKeys : [...closedKeys, key];

export const openOffice = (closedKeys: readonly string[], key: string): readonly string[] =>
  closedKeys.filter(closed => closed !== key);

/** Offices with no sessions in them: the ones worth tidying away. */
export const idleOfficeKeys = (offices: readonly StationOffice[]): string[] =>
  offices.filter(office => office.agents.length === 0).map(office => office.key);

function readSaved(): readonly string[] {
  try { return parseClosedOffices(localStorage.getItem(STORAGE_KEY)); } catch { return []; }
}

/** Closed tabs, remembered in this browser. Storage is optional; the choice still applies for this visit. */
export function useClosedOffices() {
  const [closedKeys, setClosedKeys] = useState<readonly string[]>(readSaved);
  const update = useCallback((change: (current: readonly string[]) => readonly string[]) => {
    setClosedKeys(current => {
      const next = change(current);
      if (next !== current) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage blocked. */ }
      }
      return next;
    });
  }, []);
  const close = useCallback((keys: readonly string[]) => update(current => keys.reduce(closeOffice, current)), [update]);
  const open = useCallback((key: string) => update(current => current.includes(key) ? openOffice(current, key) : current), [update]);
  return { closedKeys, close, open };
}
