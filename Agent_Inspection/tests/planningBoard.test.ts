import { afterEach, describe, expect, it, vi } from 'vitest';
import { constrainPlanning, createPlanningNode, drawingNode, emptyPlanning, imageSource, parsePlanning, planningBrief, readPlanning } from '../web/src/components/consoles/planningBoard.ts';

afterEach(() => vi.unstubAllGlobals());

describe('portable planning boards', () => {
  const note = () => ({ ...createPlanningNode('note', { x: -120, y: 75 }, 'sand'), text: 'Make the onboarding welcoming.' });
  const document = () => ({ ...emptyPlanning(), title: 'A shared idea', nodes: [note()] });
  it('round trips negative coordinates, authored text, colors and title', () => {
    const original = document();
    expect(parsePlanning(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
  it('rejects duplicate IDs instead of aliasing different objects', () => {
    const node = note();
    expect(() => parsePlanning({ ...document(), nodes: [node, node] })).toThrow(/duplicate/);
  });
  it.each([NaN, Infinity, '100', -50000])('refuses invalid coordinates (%s)', (x) => {
    expect(() => parsePlanning({ ...document(), nodes: [{ ...note(), x }] })).toThrow(/dimensions/);
  });
  it('rejects negative size and unknown object types', () => {
    expect(() => parsePlanning({ ...document(), nodes: [{ ...note(), width: -10 }] })).toThrow();
    expect(() => parsePlanning({ ...document(), nodes: [{ ...note(), kind: 'script' }] })).toThrow();
  });
  it('blocks external image requests and executable data URLs', () => {
    for (const src of ['https://example.com/tracker.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)']) {
      expect(imageSource(src)).toBe(false);
      expect(() => parsePlanning({ ...document(), nodes: [{ ...note(), kind: 'image', src }] })).toThrow(/embedded/);
    }
  });
  it('embeds raster references and strips extra fields including tokens', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    const parsed = parsePlanning({ ...document(), token: 'secret', nodes: [{ ...note(), kind: 'image', src, agentId: 'secret-session' }] });
    expect(parsed.nodes[0].src).toBe(src);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
  it('preserves the direction of an arrow drawn up and to the left', () => {
    const arrow = drawingNode('arrow', [{ x: 200, y: 250 }, { x: 100, y: 150 }], 'blue');
    expect(arrow).toMatchObject({ x: 100, y: 150, width: 100, height: 100, points: [{ x: 100, y: 100 }, { x: 0, y: 0 }] });
    expect(parsePlanning({ ...emptyPlanning(), nodes: [arrow] }).nodes[0]).toEqual(arrow);
  });
  it('rejects oversized boards, huge strokes and non-finite drawing points', () => {
    expect(() => parsePlanning({ version: 1, nodes: Array.from({ length: 501 }, note) })).toThrow(/500/);
    const draw = drawingNode('draw', [{ x: 0, y: 0 }, { x: 10, y: 20 }], 'mint');
    expect(() => parsePlanning({ ...document(), nodes: [{ ...draw, points: Array(5001).fill({ x: 0, y: 0 }) }] })).toThrow(/points/);
    expect(() => parsePlanning({ ...document(), nodes: [{ ...draw, points: [{ x: 0, y: 0 }, { x: Infinity, y: 0 }] }] })).toThrow(/coordinate/);
  });
  it('includes only selected material in an agent brief', () => {
    const selected = note();
    const doc = { ...document(), nodes: [selected, { ...note(), text: 'Do not share this other idea.' }] };
    const brief = planningBrief(doc, [selected]);
    expect(brief).toContain('A shared idea');
    expect(brief).toContain(selected.text);
    expect(brief).not.toContain('Do not share');
  });
  it('keeps authored geometry round-trippable at extreme zoom and pan', () => {
    const node = { ...note(), x: 60_000, y: -70_000, width: 50_000, height: Infinity };
    const stroke = drawingNode('draw', [{ x: -80_000, y: -70_000 }, { x: 80_000, y: 90_000 }], 'rose');
    const doc = constrainPlanning({ ...document(), nodes: [node, stroke] });
    expect(doc.nodes[0]).toMatchObject({ x: 20_000, y: -20_000, width: 20_000, height: 1 });
    expect(parsePlanning(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
  it('preserves unreadable saved bytes for recovery instead of discarding them', () => {
    const malformed = '{"version":1,"nodes":[not-a-board';
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => malformed, setItem });
    expect(readPlanning('my-project')).toEqual({ doc: emptyPlanning(), unreadable: malformed });
    expect(setItem).not.toHaveBeenCalled();
  });
});
