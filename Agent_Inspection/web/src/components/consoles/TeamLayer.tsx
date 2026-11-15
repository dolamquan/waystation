import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import type { ConsoleInfo } from '../../api.ts';
import type { BoardItem } from './boardItems.ts';
import { GROUP_HEAD, GROUP_PAD, arrangeGroup, groupFrame, markArranged, moveGroup, removeGroup, renameGroup, type CanvasGroup } from './canvasGroups.ts';
import type { CanvasState, Rect, Viewport } from './canvasLayout.ts';
import { agentConsoles, sendTeamKeys } from './teamActions.ts';
import { TeamFrame } from './TeamFrame.tsx';

const ARRANGE_GAP = 80;
const ARRANGE_TOP = 48;

type Rects = Readonly<Record<string, Rect>>;

type Props = {
  readonly ready?: boolean;
  readonly groups: readonly CanvasGroup[];
  readonly onGroupsChange: (next: readonly CanvasGroup[]) => void;
  readonly items: readonly BoardItem[];
  readonly rects: Rects;
  readonly viewport: Viewport;
  readonly update: (change: (current: CanvasState) => CanvasState) => void;
  /** Brings a world rect into view (used once a newly spawned team has been laid out). */
  readonly showRect: (rect: Rect) => void;
  readonly trackPointer: (start: ReactPointerEvent, apply: (dx: number, dy: number) => void) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onHandoff: (fromConsoleId: string | undefined) => void;
};

/** Where a new team goes: to the right of everything already on this canvas, so it never lands on other tiles. */
function freeOrigin(rects: Rects, others: readonly string[]): { x: number; y: number } {
  const placed = others.flatMap((key) => rects[key] ?? []);
  const top = ARRANGE_TOP + GROUP_HEAD + GROUP_PAD;
  if (placed.length === 0) return { x: ARRANGE_TOP + GROUP_PAD, y: top };
  return { x: Math.max(...placed.map((r) => r.x + r.width)) + ARRANGE_GAP, y: top };
}

/** Only the members' rects from a layout, so applying it cannot overwrite tiles that moved meanwhile. */
const membersOnly = (laid: Rects, group: CanvasGroup): Record<string, Rect> =>
  Object.fromEntries(group.members.flatMap((key) => (laid[key] ? [[key, laid[key]] as const] : [])));

/** The team frames drawn behind the tiles of this canvas, and laying out a freshly spawned team. */
export function TeamLayer({ groups, onGroupsChange, items, rects, viewport, update, showRect, trackPointer, notify, onHandoff, ready = true }: Props) {
  const shown = new Set(items.map((item) => item.key));
  const visible = groups.filter((group) => group.members.some((key) => shown.has(key)));

  // A team launched together is laid out in a grid once all of its consoles are on the canvas.
  const pending = ready ? visible.find((group) => !group.arranged && group.members.every((key) => rects[key])) : undefined;
  useEffect(() => {
    if (!pending) return;
    const others = Object.keys(rects).filter((key) => shown.has(key) && !pending.members.includes(key));
    const laid = membersOnly(arrangeGroup(rects, pending, freeOrigin(rects, others)), pending);
    update((current) => ({ ...current, rects: { ...current.rects, ...laid } }));
    onGroupsChange(markArranged(groups, pending.id));
    const frame = groupFrame(pending, laid);
    if (frame) showRect(frame);
    // Runs once per pending team; `pending` changes only when a different team becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  const consolesOf = (group: CanvasGroup): readonly ConsoleInfo[] =>
    agentConsoles(items.filter((item) => group.members.includes(item.key)));

  const startDrag = (event: ReactPointerEvent, group: CanvasGroup) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = rects;
    trackPointer(event, (dx, dy) => {
      const moved = membersOnly(moveGroup(origin, group, dx / viewport.zoom, dy / viewport.zoom), group);
      update((current) => ({ ...current, rects: { ...current.rects, ...moved } }));
    });
  };

  return <>
    {visible.map((group) => {
      const frame = groupFrame(group, rects);
      if (!frame) return null;
      const members = consolesOf(group);
      return <TeamFrame key={group.id} group={group} agentCount={members.length}
        style={{
          left: frame.x * viewport.zoom + viewport.panX, top: frame.y * viewport.zoom + viewport.panY,
          width: frame.width * viewport.zoom, height: frame.height * viewport.zoom,
        }}
        onDragStart={(event) => startDrag(event, group)}
        onRename={(name) => onGroupsChange(renameGroup(groups, group.id, name))}
        onPause={() => void sendTeamKeys(members, 'pause', notify)}
        onResume={() => void sendTeamKeys(members, 'resume', notify)}
        onHandoff={() => onHandoff(members[0]?.id)}
        onUngroup={() => onGroupsChange(removeGroup(groups, group.id))} />;
    })}
  </>;
}
