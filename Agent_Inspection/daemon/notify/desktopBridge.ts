import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Notifier } from './notifier.ts';

/** Only called after the daemon has authenticated the WebSocket's operator token. */
export function desktopBridge(ws: WebSocket, notifier: Notifier): void {
  const pending = new Map<string, (error?: Error) => void>();
  let unregister: (() => void) | undefined;
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message?.type === 'desktop:register' && !unregister) {
      unregister = notifier.registerDesktopDelivery((title, body, signal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Desktop notification cancelled')); return; }
        if (ws.readyState !== 1) { reject(new Error('Waystation desktop disconnected')); return; }
        const id = randomUUID();
        const finish = (error?: Error) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new Error('Desktop notification cancelled'));
        const timer = setTimeout(() => finish(new Error('Waystation desktop did not acknowledge the notification')), 8000);
        pending.set(id, finish);
        signal.addEventListener('abort', abort, { once: true });
        ws.send(JSON.stringify({ type: 'desktop:notify', id, title, body }), (error) => { if (error) finish(error); });
      }));
    } else if (message?.type === 'desktop:ack' && typeof message.id === 'string') {
      pending.get(message.id)?.(message.ok === true ? undefined : new Error(
        typeof message.error === 'string' ? message.error.slice(0, 300) : 'Windows rejected the notification',
      ));
    }
  });
  ws.once('close', () => {
    unregister?.();
    for (const finish of pending.values()) finish(new Error('Waystation desktop disconnected'));
  });
}
