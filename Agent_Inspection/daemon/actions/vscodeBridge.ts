import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Agent } from '../domain/types.ts';

interface Binding { sessionId: string; pid: number; procStart: string }
interface Client { ws: WebSocket; bindings: Binding[]; updatedAt: number }

/** Authenticated VS Code extensions own the Terminal objects; the daemon never types into an arbitrary window. */
export class VSCodeBridge {
  private clients = new Set<Client>();
  private sending = new Set<string>();
  private pending = new Map<string, { client: Client; finish: (error?: Error) => void }>();
  private closed = false;

  constructor(private readonly sessionsDir: string, private readonly changed: () => void) {}

  attach(ws: WebSocket): void {
    const client: Client = { ws, bindings: [], updatedAt: 0 };
    let registered = false;
    ws.on('message', data => {
      if (this.closed) return;
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message?.type === 'terminal:register' && message.version === 1) {
        if (!registered) {
          registered = true;
          this.clients.add(client);
          ws.send(JSON.stringify({ type: 'terminal:config', version: 1, sessionsDir: this.sessionsDir }));
        }
      } else if (registered && message?.type === 'terminal:sessions' && Array.isArray(message.sessions)) {
        const bindings: Binding[] = [];
        for (const item of message.sessions.slice(0, 100)) {
          if (item && typeof item.sessionId === 'string' && item.sessionId.length <= 200
              && Number.isInteger(item.pid) && item.pid > 4
              && typeof item.procStart === 'string' && /^\d{10,20}$/.test(item.procStart)) {
            bindings.push({ sessionId: item.sessionId, pid: item.pid, procStart: item.procStart });
          }
        }
        const differs = JSON.stringify(bindings) !== JSON.stringify(client.bindings);
        client.bindings = bindings;
        client.updatedAt = Date.now();
        if (differs) this.changed();
      } else if (registered && message?.type === 'terminal:ack' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (pending?.client !== client) return;
        pending.finish(message.ok === true ? undefined : new Error(
          typeof message.error === 'string' ? message.error.slice(0, 500) : 'VS Code could not submit the message.',
        ));
      }
    });
    ws.once('close', () => {
      this.clients.delete(client);
      for (const request of this.pending.values()) {
        if (request.client === client) request.finish(new Error('VS Code disconnected. Delivery is uncertain; check the original terminal before sending again.'));
      }
      if (registered && !this.closed) this.changed();
    });
  }

  private matches(sessionId: string, pid: number): Client[] {
    return [...this.clients].filter(client => client.ws.readyState === 1 && Date.now() - client.updatedAt < 15_000
      && client.bindings.some(binding => binding.sessionId === sessionId && binding.pid === pid));
  }

  connected(sessionId: string, pid: number): boolean { return this.matches(sessionId, pid).length === 1; }

  close(): void {
    this.closed = true;
    this.clients.clear();
    for (const request of this.pending.values()) request.finish(new Error('Waystation is shutting down. Check the terminal before resending any pending message.'));
  }

  async send(agent: Agent, procStart: string, text: string): Promise<void> {
    if (!agent.sessionId || !agent.pid) throw new Error('The session has no live terminal process.');
    const matches = this.matches(agent.sessionId, agent.pid);
    if (matches.length !== 1) throw new Error('The VS Code terminal connection changed. Reconnect the Waystation extension and try again.');
    const client = matches[0];
    if (!client.bindings.some(binding => binding.sessionId === agent.sessionId && binding.pid === agent.pid && binding.procStart === procStart)) {
      throw new Error('The Claude process changed. Refresh this session before sending.');
    }
    if (this.sending.has(agent.sessionId)) throw new Error('A message is already being submitted to this terminal.');
    this.sending.add(agent.sessionId);
    try {
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID();
        const finish = (error?: Error) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error('VS Code did not acknowledge delivery. Check the original terminal before sending again.')), 12_000);
        this.pending.set(id, { client, finish });
        client.ws.send(JSON.stringify({ type: 'terminal:send', id, expiresAt: Date.now() + 10_000, sessionId: agent.sessionId, pid: agent.pid, procStart, text }),
          error => { if (error) finish(new Error('VS Code disconnected during submission. Check the original terminal before sending again.')); });
      });
    } finally { this.sending.delete(agent.sessionId); }
  }
}
