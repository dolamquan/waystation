import type { Point, Viewport } from './canvasLayout.ts';
import type { OrchestratorLink } from './orchestratorLinks.ts';

/** One colour per orchestrator, used for its links and its tile's edge. */
export const ORCHESTRATOR_TONES = ['#b9a7e8', '#6bb7e8', '#e8c46b', '#e89ab9', '#8fd6b4', '#f0a56b'] as const;
export const orchestratorTone = (index: number): string => ORCHESTRATOR_TONES[index % ORCHESTRATOR_TONES.length]!;

/** Curves from each orchestrator tile to the teams it directs, under the tiles. Purely visual: it never takes the pointer. */
export function OrchestratorLinkLayer({ links, viewport }: { readonly links: readonly OrchestratorLink[]; readonly viewport: Viewport }) {
  if (links.length === 0) return null;
  const screen = (point: Point): Point => ({ x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY });
  const at = (point: Point) => { const p = screen(point); return `${p.x} ${p.y}`; };
  const dot = Math.max(2.5, 4.5 * Math.min(1, viewport.zoom * 2));
  return <svg className="orch-links" aria-hidden="true">
    {links.map((link) => {
      const d = `M ${at(link.from)} C ${at(link.c1)} ${at(link.c2)} ${at(link.to)}`;
      const from = screen(link.from);
      const to = screen(link.to);
      return <g key={link.key} style={{ color: orchestratorTone(link.tone) }}>
        <path className="orch-link-glow" d={d} />
        <path className="orch-link" d={d} />
        <circle className="orch-link-end" cx={from.x} cy={from.y} r={dot} />
        <circle className="orch-link-end" cx={to.x} cy={to.y} r={dot} />
      </g>;
    })}
  </svg>;
}
