#!/usr/bin/env node
// Dependency-free stdio MCP entry point. stdout is reserved for protocol messages.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.AGENT_TOWER_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-tower');
const cwd = process.env.WAYSTATION_MCP_CWD ?? process.cwd();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

function connection() {
  const info = process.env.WAYSTATION_MCP_URL
    ? { url: process.env.WAYSTATION_MCP_URL, token: process.env.WAYSTATION_MCP_TOKEN }
    : JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
  const url = new URL('/mcp', info.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Waystation MCP must use a local HTTP endpoint.');
  if (typeof info.token !== 'string' || !info.token) throw new Error('Missing Waystation MCP token.');
  return { url, token: info.token };
}

async function handle(request) {
  if (request.id === undefined) return; // No client notifications require server state.
  try {
    const { url, token } = connection(); // Re-read discovery on each call, surviving daemon restarts.
    if (request.method === 'tools/call' && request.params && typeof request.params === 'object') {
      request = { ...request, params: { ...request.params, arguments: { project: cwd, ...request.params.arguments } } };
    }
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Waystation answered HTTP ${response.status}. Keep the app running; restart this agent if its managed grant expired.`);
    send(await response.json());
  } catch (error) {
    const message = `Waystation unavailable: ${error.message}. Start Waystation and retry.`;
    send({ jsonrpc: '2.0', id: request.id, ...(request.method === 'tools/call'
      ? { result: { content: [{ type: 'text', text: message }], isError: true } }
      : { error: { code: -32603, message } }) });
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
  }
  void handle(request);
});
