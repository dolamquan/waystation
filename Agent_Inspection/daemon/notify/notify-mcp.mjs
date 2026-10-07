#!/usr/bin/env node
// WayStation notify bridge: a dependency-free MCP server (stdio, newline-delimited JSON-RPC) giving
// an agent one tool, `notify`, to message the operator. It holds no state: each call is forwarded
// to the tower daemon with this agent's own token, which decides where the message goes.

import { createInterface } from 'node:readline';

const BASE_URL = process.env.AGENT_TOWER_NOTIFY_URL ?? '';
const TOKEN = process.env.AGENT_TOWER_NOTIFY_TOKEN ?? '';
const REQUEST_TIMEOUT_MS = 30_000;
const FALLBACK_PROTOCOL = '2025-06-18';

const NOTIFY_TOOL = {
  name: 'notify',
  description: 'Send an update to the operator (in-app Updates inbox plus any channels they chose, e.g. Slack or email). Use it for important progress and a short final summary. Keep it brief.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'One-line headline (max 200 characters).' },
      body: { type: 'string', description: 'Details (max 8000 characters).' },
      level: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Defaults to info.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function tower(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `tower answered ${response.status}`);
  return data;
}

function summarize(results) {
  const failed = (results ?? []).filter((result) => !result.ok);
  if (failed.length === 0) return 'Sent.';
  return `Recorded in the operator's inbox; not delivered to: ${failed.map((result) => `${result.channelId} (${result.error ?? 'failed'})`).join(', ')}`;
}

async function callTool(params) {
  if (params?.name !== 'notify') return { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true };
  try {
    const args = params.arguments ?? {};
    const result = await tower('/agent/notify', { title: args.title, body: args.body, level: args.level });
    return { content: [{ type: 'text', text: summarize(result.results) }], isError: false };
  } catch (error) {
    return { content: [{ type: 'text', text: `Notification not sent: ${error.message}` }], isError: true };
  }
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'waystation-notify', version: '0.1.0' },
        instructions: 'Use the notify tool to send the operator short updates.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [NOTIFY_TOOL] };
    case 'tools/call':
      return callTool(params);
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
