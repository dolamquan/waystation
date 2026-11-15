#!/usr/bin/env node
// Waystation factory bridge: a dependency-free MCP server (stdio, newline-delimited JSON-RPC).
// Each factory agent launches it to submit its stage result as structured data. It holds no
// state: every call is forwarded to the daemon with this attempt's own token, so an agent can
// only ever submit for the stage it is running. Submissions are advisory and approve nothing.

import { createInterface } from 'node:readline';

const BASE_URL = process.env.WAYSTATION_FACTORY_URL ?? '';
const TOKEN = process.env.WAYSTATION_FACTORY_TOKEN ?? '';
const REQUEST_TIMEOUT_MS = 30_000;
const FALLBACK_PROTOCOL = '2025-06-18';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function daemon(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Waystation answered ${response.status}`);
  return data;
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'waystation-factory', version: '0.1.0' },
        instructions: 'Submit your factory stage result with the one tool offered, then end your turn.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: (await daemon('/agent/factory/tools')).tools };
    case 'tools/call':
      try {
        const result = await daemon('/agent/factory/call', { name: params?.name, arguments: params?.arguments ?? {} });
        return { content: [{ type: 'text', text: String(result.text ?? '') }], isError: result.isError === true };
      } catch (error) {
        return { content: [{ type: 'text', text: `Factory unavailable: ${error.message}` }], isError: true };
      }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  // Notifications (no id) need no answer.
  if (request.id === undefined || request.id === null) return;
  handle(request.method, request.params).then(
    (result) => send({ id: request.id, result }),
    (error) => send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
});
