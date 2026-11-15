import { describe, expect, it } from 'vitest';
import { keyRoute, type KeyLike } from '../web/src/components/consoles/browserKeys.ts';

const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, altGraph: false, ...extra });

describe('browser tile key routing', () => {
  it('sends ASCII characters, named keys and shortcuts as real key presses', () => {
    for (const key of ['a', 'k', 'F', ' ', '1', 'Backspace', 'Enter', 'ArrowLeft', 'Escape']) expect(keyRoute(press(key))).toBe('key');
    expect(keyRoute(press('a', { ctrlKey: true }))).toBe('key');
  });

  it('sends Unikey letters and input-method text as typed text', () => {
    for (const key of ['â', 'ư', 'ệ', 'đ', 'Process', 'Unidentified', 'Dead', '😀']) expect(keyRoute(press(key))).toBe('text');
    expect(keyRoute(press('a', { isComposing: true }))).toBe('text');
    expect(keyRoute(press('€', { ctrlKey: true, altKey: true, altGraph: true }))).toBe('text');
  });
});
