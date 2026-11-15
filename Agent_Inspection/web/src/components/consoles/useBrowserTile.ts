import { useEffect, useRef, useState } from 'react';
import { socketProtocols } from '../../api.ts';
import type { BrowserAction, BrowserEvent, BrowserState } from '../../../../shared/browserTiles.ts';

export function useBrowserTile(id: string) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [state, setState] = useState<BrowserState>();
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<Extract<BrowserEvent, { type: 'dialog' }>>();
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const send = (action: BrowserAction) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(action));
  };

  useEffect(() => {
    let active = true, painting = false, sized = false;
    let pendingFrame: Blob | undefined;
    const paint = async (frame: Blob): Promise<void> => {
      painting = true;
      try {
        const bitmap = await createImageBitmap(frame);
        const target = canvas.current;
        if (active && target) {
          target.width = bitmap.width; target.height = bitmap.height;
          target.getContext('2d')?.drawImage(bitmap, 0, 0);
          setHasFrame(true);
        }
        bitmap.close();
      } catch { /* An undecodable frame is replaced by the next one. */ }
      finally {
        painting = false;
        const next = pendingFrame; pendingFrame = undefined;
        if (next && active) void paint(next);
      }
    };
    let resizeTimer: ReturnType<typeof setTimeout>;
    setConnected(false); setHasFrame(false); setError(undefined); setDialog(undefined); setState(undefined); setPageFullscreen(false);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/browser/${encodeURIComponent(id)}`, socketProtocols());
    socket.current = ws;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const element = canvas.current;
        if (element && ws.readyState === WebSocket.OPEN) send({ type: 'resize',
          width: Math.max(240, Math.min(1920, element.clientWidth)), height: Math.max(180, Math.min(1440, element.clientHeight)) });
      }, 120);
    };
    const observer = new ResizeObserver(resize);
    if (canvas.current) observer.observe(canvas.current);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      const element = canvas.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? element.height : 1;
      send({ type: 'wheel', x: (event.clientX - rect.left) * element.width / rect.width,
        y: (event.clientY - rect.top) * element.height / rect.height,
        deltaX: Math.max(-10000, Math.min(10000, event.deltaX * unit)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * unit)) });
    };
    const element = canvas.current;
    element?.addEventListener('wheel', wheel, { passive: false });
    ws.onopen = () => { if (active) resize(); };
    ws.onmessage = async ({ data }: MessageEvent<string | Blob>) => {
      if (!active) return;
      if (typeof data === 'string') {
        const event = JSON.parse(data) as BrowserEvent;
        if (event.type === 'state') {
          setConnected(true); setState(event); if (event.loading) setError(undefined);
          if (!sized) { sized = true; resize(); }
        }
        else if (event.type === 'error') setError(event.message);
        else if (event.type === 'dialog') setDialog(event);
        else if (event.type === 'fullscreen') setPageFullscreen(event.active);
        return;
      }
      // A still page sends no further frames, so the newest one must be painted even if it arrives mid-paint.
      if (painting) { pendingFrame = data; return; }
      void paint(data);
    };
    ws.onclose = () => { if (active) { setConnected(false); setPageFullscreen(false); setError(previous => previous ?? 'Browser disconnected. Reconnect to continue.'); } };
    ws.onerror = () => { if (active) setError('Could not connect to the browser. Reconnect to try again.'); };
    return () => {
      active = false; observer.disconnect(); clearTimeout(resizeTimer);
      element?.removeEventListener('wheel', wheel);
      ws.close();
      if (socket.current === ws) socket.current = undefined;
    };
  }, [id, attempt]);

  return { canvas, connected, hasFrame, state, error, dialog, pageFullscreen, send, setError, setDialog, reconnect: () => setAttempt(value => value + 1) };
}
