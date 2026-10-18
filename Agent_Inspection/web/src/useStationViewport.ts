import { useEffect, useRef, useState, type RefObject } from 'react';
import { MIN_ROWS, sceneBox } from './stationLayout.ts';

/** Characters and desks keep this size range on screen; a larger office scrolls instead of shrinking. */
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.15;
const ZOOM = 1.4;
const DRAG_THRESHOLD_PX = 5;

/**
 * Scale for the station: chosen so a standard (MIN_ROWS) office fills the frame's width, then held
 * constant however many rows the office grows to. Zoom multiplies it.
 */
export function useStationScale(ref: RefObject<HTMLElement | null>, zoomed: boolean): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  const fit = width > 0 ? width / sceneBox(MIN_ROWS).width : 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)) * (zoomed ? ZOOM : 1);
}

/** Drag with the mouse to look around a station larger than its frame. A drag never counts as a click. */
export function useDragPan<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let start: { x: number; y: number; left: number; top: number } | undefined;
    let dragged = false;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      dragged = false;
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragged = true;
      el.classList.add('scene-panning');
      el.scrollLeft = start.left - dx;
      el.scrollTop = start.top - dy;
    };
    const up = () => {
      start = undefined;
      el.classList.remove('scene-panning');
    };
    const click = (e: MouseEvent) => {
      if (!dragged) return;
      e.stopPropagation();
      e.preventDefault();
      dragged = false;
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('click', click, true);
    };
  }, []);
  return ref;
}
