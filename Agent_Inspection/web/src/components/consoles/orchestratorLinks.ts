/**
 * The curves drawn on the canvas from each orchestrator tile to the frames of the teams it directs. Pure geometry in
 * world pixels; the canvas turns the result into screen pixels. No React and no DOM.
 */
import type { Point, Rect } from './canvasLayout.ts';

export interface OrchestratorLink {
  readonly key: string;
  readonly from: Point;
  readonly to: Point;
  /** Control points of a cubic Bezier from `from` to `to`. */
  readonly c1: Point;
  readonly c2: Point;
  /** Index into the link palette: every orchestrator keeps one colour for all its links. */
  readonly tone: number;
}

const MIN_BEND = 60;

const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/**
 * Leaves each box from the side facing the other: top/bottom when one is above the other (so a curve to a team never
 * runs along the row of teams beside it), left/right only when they share some height.
 */
export function linkBetween(from: Rect, to: Rect): Pick<OrchestratorLink, 'from' | 'to' | 'c1' | 'c2'> {
  const a = centre(from);
  const b = centre(to);
  const stacked = from.y + from.height <= to.y || to.y + to.height <= from.y;
  if (!stacked) {
    const right = b.x > a.x;
    const start = { x: right ? from.x + from.width : from.x, y: a.y };
    const end = { x: right ? to.x : to.x + to.width, y: b.y };
    const bend = Math.max(MIN_BEND, Math.abs(end.x - start.x) / 2) * (right ? 1 : -1);
    return { from: start, to: end, c1: { x: start.x + bend, y: start.y }, c2: { x: end.x - bend, y: end.y } };
  }
  const down = b.y > a.y;
  const start = { x: a.x, y: down ? from.y + from.height : from.y };
  const end = { x: b.x, y: down ? to.y : to.y + to.height };
  const bend = Math.max(MIN_BEND, Math.abs(end.y - start.y) / 2) * (down ? 1 : -1);
  return { from: start, to: end, c1: { x: start.x, y: start.y + bend }, c2: { x: end.x, y: end.y - bend } };
}

/**
 * One link per (orchestrator, wired team) and (orchestrator, wired agent) pair. Teams without a frame yet, agents not
 * on the stage and orchestrators not on the stage are skipped.
 */
export function orchestratorLinks(
  orchestrators: ReadonlyArray<{ readonly key: string; readonly teams: readonly string[]; readonly agents?: readonly string[] }>,
  frames: ReadonlyArray<{ readonly id: string; readonly frame: Rect }>,
  rects: Readonly<Record<string, Rect>>,
): readonly OrchestratorLink[] {
  return orchestrators.flatMap((orchestrator, tone) => {
    const rect = rects[orchestrator.key];
    if (!rect) return [];
    const teams = frames.filter((team) => orchestrator.teams.includes(team.id))
      .map((team) => ({ key: `${orchestrator.key}>${team.id}`, tone, ...linkBetween(rect, team.frame) }));
    const agents = (orchestrator.agents ?? []).flatMap((key) => {
      const target = rects[key];
      return target ? [{ key: `${orchestrator.key}>${key}`, tone, ...linkBetween(rect, target) }] : [];
    });
    return [...teams, ...agents];
  });
}
