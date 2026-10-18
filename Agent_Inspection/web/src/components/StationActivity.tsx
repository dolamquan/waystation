import type { Agent } from '../api.ts';
import type { SceneBox } from '../stationLayout.ts';
import { workUpdateLines } from './stationEvents.ts';

export interface ActivityPosition {
  readonly agent: Agent;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly speakerX?: number;
}
const WIDTH = 184;
const HEIGHT = 46;
const GAP = 8;

/** Keep neighbouring desk and subagent updates separate, inside the scene. */
export function placeWorkUpdates(items: readonly ActivityPosition[], box: SceneBox, reserved: readonly { left: number; top: number; width: number; height: number }[] = []) {
  const placed: Array<ActivityPosition & { left: number; top: number }> = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const left = Math.max(box.x + GAP, Math.min(item.x - WIDTH / 2, box.x + box.width - WIDTH - GAP));
    let top = Math.max(box.y + GAP, item.y - 181);
    const overlaps = () => placed.some(other => left < other.left + WIDTH + GAP && left + WIDTH + GAP > other.left && top < other.top + HEIGHT + GAP && top + HEIGHT + GAP > other.top)
      || reserved.some(other => left < other.left + other.width + GAP && left + WIDTH + GAP > other.left && top < other.top + other.height + GAP && top + HEIGHT + GAP > other.top);
    while (overlaps() && top - HEIGHT - GAP >= box.y + GAP) top -= HEIGHT + GAP;
    // A dense first row can exhaust the space above it; use the next clear lane.
    while (overlaps()) top += HEIGHT + GAP;
    placed.push({ ...item, left, top });
  }
  return placed;
}

export function StationActivity({ item, onSelect }: { readonly item: ReturnType<typeof placeWorkUpdates>[number]; readonly onSelect?: (id: string) => void }) {
  const lines = workUpdateLines(item.text);
  const open = () => onSelect?.(item.agent.id);
  const speakerX = (item.speakerX ?? item.x) - item.left;
  const tailX = Math.max(14, Math.min(WIDTH - 14, speakerX));
  const below = item.top > item.y;
  const edgeY = below ? 0 : HEIGHT;
  const tipY = edgeY + (below ? -9 : 9);
  const headY = (below ? item.y : item.y - (item.agent.parentId ? 45 : 80)) - item.top;
  return <g className="station-work-update" transform={`translate(${item.left} ${item.top})`}
    aria-label={`${item.agent.name}: ${item.text}`}>
    <path className="station-work-connector" d={`M${tailX} ${tipY}L${speakerX} ${headY}`} />
    <path className="station-work-tail" d={`M${tailX - 5} ${edgeY}L${tailX} ${tipY}L${tailX + 5} ${edgeY}`} />
    <g className="station-work-trigger" role={onSelect ? 'button' : 'img'} tabIndex={onSelect ? 0 : undefined}
      aria-label={`${item.agent.name}: ${item.text}${onSelect ? '. Open conversation' : ''}`}
      onClick={open} onKeyDown={event => { if (onSelect && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } }}>
    <title>{`${item.agent.name}: ${item.text}`}</title>
    <rect className="station-work-paper" width={WIDTH} height={HEIGHT} rx="9" />
    <circle className="station-work-dot" cx="12" cy={lines.length === 1 ? 23 : 16} r="3" />
    <text className="station-work-text" x="23" y={lines.length === 1 ? 27 : 20} fontSize="10.5" fontWeight="600">
      {lines.map((line, index) => <tspan key={index} x="23" dy={index ? 14 : 0}>{line}</tspan>)}
    </text>
    </g>
  </g>;
}
