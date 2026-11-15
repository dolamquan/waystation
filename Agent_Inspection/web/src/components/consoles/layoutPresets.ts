import type { ConsoleKind } from '../../api.ts';

/**
 * Saved console layouts for the launch composer. Pure logic, no React: everything read from
 * localStorage is untrusted (hand-edited, older version, other tab), so it is sanitised on the way in.
 * Presets hold no folder: that is chosen at launch so one layout works for any project.
 */
export interface PresetSlot {
  readonly kind: ConsoleKind;
  readonly name?: string;
}

export interface LayoutPreset {
  readonly id: string;
  readonly name: string;
  readonly slots: readonly PresetSlot[];
}

/** The subset of Storage we use, so tests can pass a fake and blocked storage is easy to model. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PRESETS_KEY = 'waystation-console-presets';
export const MAX_SLOTS = 12;
export const MAX_PRESETS = 20;
export const MAX_NAME_LENGTH = 40;

const KINDS: readonly ConsoleKind[] = ['claude', 'codex', 'shell'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_NAME_LENGTH).trim();
  return trimmed || undefined;
};

function sanitizeSlot(value: unknown): PresetSlot | undefined {
  if (!isRecord(value)) return undefined;
  const kind = KINDS.find((candidate) => candidate === value.kind);
  if (!kind) return undefined;
  const name = cleanName(value.name);
  return name ? { kind, name } : { kind };
}

/** Returns a clean preset, or undefined when the value is not usable. */
export function sanitizePreset(value: unknown): LayoutPreset | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(value.slots)) return undefined;
  const name = cleanName(value.name);
  if (!name) return undefined;
  const slots = value.slots.map(sanitizeSlot).filter((slot): slot is PresetSlot => slot !== undefined).slice(0, MAX_SLOTS);
  return slots.length > 0 ? { id: value.id, name, slots } : undefined;
}

/** Cleans a whole stored list: drops junk and duplicate ids, caps the count. */
export function sanitizePresets(value: unknown): readonly LayoutPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: LayoutPreset[] = [];
  for (const item of value) {
    const preset = sanitizePreset(item);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    result.push(preset);
    if (result.length >= MAX_PRESETS) break;
  }
  return result;
}

/** Adds (or replaces, by id) a preset; a full list is returned unchanged. */
export function addPreset(list: readonly LayoutPreset[], preset: LayoutPreset): readonly LayoutPreset[] {
  if (list.some((existing) => existing.id === preset.id)) return list.map((existing) => (existing.id === preset.id ? preset : existing));
  return list.length >= MAX_PRESETS ? list : [...list, preset];
}

export const removePreset = (list: readonly LayoutPreset[], id: string): readonly LayoutPreset[] =>
  list.filter((preset) => preset.id !== id);

export function renamePreset(list: readonly LayoutPreset[], id: string, name: string): readonly LayoutPreset[] {
  const next = cleanName(name);
  if (!next) return list;
  return list.map((preset) => (preset.id === id ? { ...preset, name: next } : preset));
}

export const BUILT_IN_PRESETS: readonly LayoutPreset[] = [
  { id: 'builtin-solo', name: 'Solo + shell', slots: [{ kind: 'claude' }, { kind: 'shell' }] },
  { id: 'builtin-build-review', name: 'Build + review', slots: [{ kind: 'claude', name: 'builder' }, { kind: 'claude', name: 'reviewer' }] },
  { id: 'builtin-pair', name: 'Pair', slots: [{ kind: 'claude' }, { kind: 'codex' }] },
  { id: 'builtin-quad', name: 'Quad', slots: [{ kind: 'claude' }, { kind: 'claude' }, { kind: 'codex' }, { kind: 'codex' }] },
];

/** Storage may be missing (node, tests) or throw on access (blocked cookies), so resolve it defensively. */
export function browserStorage(): KeyValueStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function loadPresets(storage: KeyValueStorage | undefined = browserStorage()): readonly LayoutPreset[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PRESETS_KEY);
    return raw ? sanitizePresets(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Returns whether the write stuck, so the UI can say when presets will not persist. */
export function savePresets(list: readonly LayoutPreset[], storage: KeyValueStorage | undefined = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PRESETS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
