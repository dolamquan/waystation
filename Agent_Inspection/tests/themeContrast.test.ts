import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/*
 * Guards the theme against unreadable text: every text token must clear WCAG AA (4.5:1) on every surface it is
 * drawn on, in both themes, and always-dark areas must carry the full dark token set so a light app theme can
 * never put light-theme buttons or text inside them.
 */
const css = readFileSync(new URL('../web/src/theme.css', import.meta.url), 'utf8');

function block(selectorStart: string): Record<string, string> {
  const start = css.indexOf(selectorStart);
  expect(start, `theme.css has a block starting "${selectorStart}"`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim();
  return tokens;
}

const dark = block(':root, .surface-dark {');
const light = { ...dark, ...block(":root[data-theme='light'] {") };

function rgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`expected a 6-digit hex color, got ${hex}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const channel = (value: number) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['--text', '--text-2', '--muted', '--faint', '--green-text', '--amber-text', '--red-text', '--blue-text', '--violet-text', '--clay-text'];
const SURFACES = ['--bg', '--bg-2', '--panel', '--panel-2', '--panel-3'];
const AA = 4.5;

describe.each([['dark', dark], ['light', light]] as const)('%s theme', (_name, tokens) => {
  test.each(TEXT)('%s is readable on every surface', (text) => {
    for (const surface of SURFACES) {
      expect(contrast(tokens[text], tokens[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
  });

  test('primary buttons are readable', () => {
    expect(contrast(tokens['--primary'], tokens['--on-primary'])).toBeGreaterThanOrEqual(AA);
  });

  test('always-dark text is readable on always-dark surfaces', () => {
    for (const text of ['--on-deep', '--on-deep-muted']) {
      for (const surface of ['--deep', '--deep-2']) {
        expect(contrast(tokens[text], tokens[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});

test('dark islands re-declare every token, roles and aliases included', () => {
  for (const name of ['--primary', '--on-primary', '--text', '--panel', '--ink', '--paper', '--accent', '--faint']) {
    expect(dark[name], name).toBeDefined();
  }
});

test('text selection only tints, so selected text keeps its own readable color', () => {
  const rule = /::selection\s*\{([^}]*)\}/.exec(css);
  expect(rule).not.toBeNull();
  expect(rule![1]).not.toMatch(/(^|;|\s)color\s*:/);
});
