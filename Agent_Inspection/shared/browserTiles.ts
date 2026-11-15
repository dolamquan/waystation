/** Only these user actions cross the browser socket. Raw DevTools commands are never accepted. */
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'exitFullscreen' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'pointer'; action: 'move' | 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right'; clicks: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up'; key: string }
  | { type: 'text'; text: string }
  | { type: 'dialog'; accept: boolean; text?: string };

export interface BrowserState {
  type: 'state'; url: string; title: string; loading: boolean; back: boolean; forward: boolean;
}
export type BrowserEvent = BrowserState | { type: 'error'; message: string }
  | { type: 'dialog'; kind: string; message: string; defaultValue: string }
  /** The page entered or left full screen (a video player's full-screen button); the tile follows it. */
  | { type: 'fullscreen'; active: boolean };

const finite = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;

export function parseBrowserAction(raw: string): BrowserAction | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { type } = value;
  if (type === 'back' || type === 'forward' || type === 'reload' || type === 'exitFullscreen') return { type };
  if (type === 'navigate' && typeof value.url === 'string' && value.url.length <= 2048) return { type, url: value.url };
  if (type === 'resize' && finite(value.width, 1920) && finite(value.height, 1440) && Number(value.width) >= 240 && Number(value.height) >= 180)
    return { type, width: Math.round(Number(value.width)), height: Math.round(Number(value.height)) };
  if (type === 'pointer' && ['move', 'down', 'up'].includes(String(value.action)) && finite(value.x, 1920) && finite(value.y, 1440)
    && Number(value.x) >= 0 && Number(value.y) >= 0 && ['left', 'middle', 'right'].includes(String(value.button)) && typeof value.clicks === 'number' && [1, 2, 3].includes(value.clicks))
    return value as unknown as BrowserAction;
  if (type === 'wheel' && finite(value.x, 1920) && finite(value.y, 1440) && finite(value.deltaX, 10000) && finite(value.deltaY, 10000))
    return value as unknown as BrowserAction;
  if (type === 'key' && ['down', 'up'].includes(String(value.action)) && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 64)
    return { type, action: value.action as 'down' | 'up', key: value.key };
  if (type === 'text' && typeof value.text === 'string' && value.text.length <= 16000) return { type, text: value.text };
  if (type === 'dialog' && typeof value.accept === 'boolean' && (value.text === undefined || typeof value.text === 'string' && value.text.length <= 16000))
    return { type, accept: value.accept, text: value.text as string | undefined };
}
