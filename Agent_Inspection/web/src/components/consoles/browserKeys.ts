/** What a key press in a browser tile becomes on the remote page. */
export type KeyRoute = 'key' | 'text';

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly altGraph: boolean;
}

/**
 * Plain ASCII characters and named keys travel as real key presses, so page shortcuts (YouTube's "k", game keys) work.
 * Anything an input method produces — Unikey's Vietnamese letters, IME compositions, dead keys, AltGr characters —
 * is left to the hidden text box and sent as typed text, which the remote page receives exactly.
 */
export function keyRoute(event: KeyLike): KeyRoute {
  if (event.isComposing || ['Process', 'Dead', 'Unidentified'].includes(event.key)) return 'text';
  const characters = Array.from(event.key);
  if (characters.length !== 1) return 'key';
  if (event.altGraph) return 'text';
  if (event.ctrlKey || event.metaKey || event.altKey) return 'key';
  return characters[0].codePointAt(0)! < 0x80 ? 'key' : 'text';
}
