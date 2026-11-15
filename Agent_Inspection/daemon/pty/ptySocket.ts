import type { WebSocket } from 'ws';
import type { PtyManager } from './ptyManager.ts';
import type { ConsoleClientMessage, ConsoleServerMessage } from './types.ts';

/** WebSocket close code for "no such console". */
export const CLOSE_NO_SUCH_CONSOLE = 4404;
/** A viewer that falls this far behind is dropped; it repaints from the replay when it reconnects. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_TRY_AGAIN_LATER = 1013;

export function parseClientMessage(raw: string): ConsoleClientMessage | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;
  const { type, data, cols, rows } = message as Record<string, unknown>;
  if (type === 'input' && typeof data === 'string') return { type, data };
  if (type === 'resize' && typeof cols === 'number' && typeof rows === 'number') return { type, cols, rows };
  return undefined;
}

/** Connects one browser socket to one console: repaint, stream output, and pass keystrokes and resizes back. */
export function attachConsoleSocket(ws: WebSocket, manager: PtyManager, id: string): void {
  const send = (message: ConsoleServerMessage) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.close(CLOSE_TRY_AGAIN_LATER, 'viewer too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const subscription = manager.subscribe(id, send);
  if (!subscription) {
    ws.close(CLOSE_NO_SUCH_CONSOLE, 'no such console');
    return;
  }
  send({ type: 'replay', data: subscription.replay });
  const info = manager.get(id);
  if (info?.state === 'exited') send({ type: 'exit', code: info.exitCode ?? 0 });
  ws.on('message', (data) => {
    const message = parseClientMessage(data.toString());
    if (!message) return;
    if (message.type === 'input') manager.write(id, message.data);
    else manager.resize(id, message.cols, message.rows);
  });
  ws.on('close', subscription.unsubscribe);
  ws.on('error', (error) => console.error('[pty-ws]', error.message));
}
