import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PRESETS, MAX_NAME_LENGTH, MAX_PRESETS, MAX_SLOTS, PRESETS_KEY,
  addPreset, loadPresets, removePreset, renamePreset, sanitizePreset, sanitizePresets, savePresets,
  type KeyValueStorage, type LayoutPreset,
} from '../web/src/components/consoles/layoutPresets.ts';

const preset = (id: string, name = id): LayoutPreset => ({ id, name, slots: [{ kind: 'claude' }] });

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { readonly data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
  };
}

const throwing: KeyValueStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('quota'); },
};

describe('sanitizePreset', () => {
  it('accepts a valid preset and trims names', () => {
    expect(sanitizePreset({ id: 'a', name: '  Duo  ', slots: [{ kind: 'claude', name: ' lead ' }, { kind: 'codex' }] }))
      .toEqual({ id: 'a', name: 'Duo', slots: [{ kind: 'claude', name: 'lead' }, { kind: 'codex' }] });
  });

  it.each([null, 42, 'x', [], {}, { id: 'a' }, { id: '', name: 'n', slots: [{ kind: 'claude' }] },
    { id: 'a', name: '   ', slots: [{ kind: 'claude' }] }, { id: 'a', name: 'n', slots: [] },
    { id: 'a', name: 'n', slots: 'claude' }])('rejects junk %#', (junk) => {
    expect(sanitizePreset(junk)).toBeUndefined();
  });

  it('drops slots with unknown kinds and rejects the preset if none remain', () => {
    expect(sanitizePreset({ id: 'a', name: 'n', slots: [{ kind: 'rm -rf' }, { kind: 'shell' }] })?.slots).toEqual([{ kind: 'shell' }]);
    expect(sanitizePreset({ id: 'a', name: 'n', slots: [{ kind: 'bogus' }, null] })).toBeUndefined();
  });

  it('caps slots and name length', () => {
    const slots = Array.from({ length: 30 }, () => ({ kind: 'claude' }));
    const result = sanitizePreset({ id: 'a', name: 'x'.repeat(200), slots });
    expect(result?.slots).toHaveLength(MAX_SLOTS);
    expect(result?.name).toHaveLength(MAX_NAME_LENGTH);
  });

  it('omits empty or non-string slot names', () => {
    expect(sanitizePreset({ id: 'a', name: 'n', slots: [{ kind: 'claude', name: '  ' }, { kind: 'codex', name: 7 }] })?.slots)
      .toEqual([{ kind: 'claude' }, { kind: 'codex' }]);
  });
});

describe('sanitizePresets', () => {
  it('returns [] for non-arrays', () => {
    expect(sanitizePresets('nope')).toEqual([]);
    expect(sanitizePresets(undefined)).toEqual([]);
  });

  it('drops invalid entries, duplicates ids, and caps the list', () => {
    const many = Array.from({ length: 50 }, (_, index) => preset(`p${index}`));
    expect(sanitizePresets(many)).toHaveLength(MAX_PRESETS);
    expect(sanitizePresets([preset('a'), { bad: true }, preset('a', 'again')])).toEqual([preset('a')]);
  });
});

describe('immutable list edits', () => {
  it('addPreset appends without mutating, and refuses past the cap', () => {
    const list = [preset('a')];
    const next = addPreset(list, preset('b'));
    expect(next.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list).toHaveLength(1);
    const full = Array.from({ length: MAX_PRESETS }, (_, index) => preset(`p${index}`));
    expect(addPreset(full, preset('extra'))).toBe(full);
  });

  it('addPreset replaces a preset that has the same id', () => {
    expect(addPreset([preset('a', 'old')], preset('a', 'new')).map((p) => p.name)).toEqual(['new']);
  });

  it('removePreset drops by id without mutating', () => {
    const list = [preset('a'), preset('b')];
    expect(removePreset(list, 'a')).toEqual([preset('b')]);
    expect(list).toHaveLength(2);
  });

  it('renamePreset trims, caps, ignores blank names and leaves the original intact', () => {
    const list = [preset('a', 'old')];
    expect(renamePreset(list, 'a', '  fresh ')[0].name).toBe('fresh');
    expect(renamePreset(list, 'a', 'y'.repeat(99))[0].name).toHaveLength(MAX_NAME_LENGTH);
    expect(renamePreset(list, 'a', '   ')).toBe(list);
    expect(list[0].name).toBe('old');
  });
});

describe('built-in presets', () => {
  it('are valid, unique, and survive sanitising unchanged', () => {
    expect(new Set(BUILT_IN_PRESETS.map((p) => p.id)).size).toBe(BUILT_IN_PRESETS.length);
    expect(sanitizePresets(BUILT_IN_PRESETS)).toEqual(BUILT_IN_PRESETS);
    expect(BUILT_IN_PRESETS.length).toBeGreaterThan(2);
  });
});

describe('storage wrappers', () => {
  it('round-trips through storage under the documented key', () => {
    const storage = fakeStorage();
    expect(savePresets([preset('a')], storage)).toBe(true);
    expect(Object.keys(storage.data)).toEqual([PRESETS_KEY]);
    expect(PRESETS_KEY).toBe('waystation-console-presets');
    expect(loadPresets(storage)).toEqual([preset('a')]);
  });

  it('returns [] for corrupt JSON, empty storage and junk contents', () => {
    expect(loadPresets(fakeStorage())).toEqual([]);
    expect(loadPresets(fakeStorage({ [PRESETS_KEY]: '{not json' }))).toEqual([]);
    expect(loadPresets(fakeStorage({ [PRESETS_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it('never throws when storage is blocked', () => {
    expect(loadPresets(throwing)).toEqual([]);
    expect(savePresets([preset('a')], throwing)).toBe(false);
  });

  it('never throws when storage is missing entirely', () => {
    expect(loadPresets(undefined)).toEqual([]);
    expect(savePresets([preset('a')], undefined)).toBe(false);
  });
});
