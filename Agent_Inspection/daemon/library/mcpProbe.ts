import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stopProcessTree } from '../actions/kill.ts';
import type { McpTestResult } from './types.ts';

/** A minimal MCP client: connect, `initialize`, `tools/list`, disconnect. Used by "Test" in the library. */

export const PROBE_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_ERROR = 300;
const STDERR_TAIL = 2000;

type Json = Record<string, unknown>;

export interface StdioProbeTarget {
  readonly command: string;
  readonly args: readonly string[];
  /** The full child environment (secrets included). */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface RemoteProbeTarget {
  readonly type: 'http' | 'sse';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

const initializeRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'waystation-probe', version: '1.0.0' } } };
const initializedNote = { jsonrpc: '2.0', method: 'notifications/initialized' };
const toolsRequest = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** Replaces every secret value in a message, then trims it. Errors are shown to the operator and may be logged. */
export function redact(message: string, secrets: readonly string[]): string {
  const cleaned = secrets.filter((s) => s.length >= 4).reduce((text, secret) => text.split(secret).join('•••'), message);
  const oneLine = cleaned.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ERROR ? `${oneLine.slice(0, MAX_ERROR - 1)}…` : oneLine;
}

function toolNames(result: unknown): string[] {
  const tools = (result as Json | undefined)?.tools;
  return Array.isArray(tools) ? tools.flatMap((tool) => (typeof (tool as Json)?.name === 'string' ? [(tool as Json).name as string] : [])) : [];
}

function rpcError(message: Json): string | undefined {
  const error = message.error as Json | undefined;
  return error ? `the server answered with an error: ${String(error.message ?? 'unknown error')}` : undefined;
}

// ---- stdio ------------------------------------------------------------------------------------------

export function probeStdio(target: StdioProbeTarget, timeoutMs = PROBE_TIMEOUT_MS, secrets: readonly string[] = []): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(target.command, [...target.args], {
      cwd: target.cwd, env: target.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (result: McpTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.destroy();
      if (child.pid && child.exitCode === null) {
        stopProcessTree(child.pid).catch(() => child.kill());
      }
      resolve(result.error ? { ok: false, error: redact(result.error, secrets) } : result);
    };
    const fail = (error: string) => finish({ ok: false, error });
    const timer = setTimeout(() => fail(`no answer within ${Math.round(timeoutMs / 1000)}s${stderr.trim() ? `: ${stderr.trim()}` : ''}`), timeoutMs);
    const send = (message: Json) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.on('error', (error) => fail(`could not start "${target.command}": ${error.message}`));
    child.on('close', (code) => fail(`the server exited (code ${code ?? 'unknown'}) before listing its tools${stderr.trim() ? `: ${stderr.trim().slice(-MAX_ERROR)}` : ''}`));
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL); });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        return;
      }
      const failure = rpcError(message);
      if (message.id === 1) {
        if (failure) return fail(failure);
        send(initializedNote);
        send(toolsRequest);
      } else if (message.id === 2) {
        finish(failure ? { ok: false, error: failure } : { ok: true, tools: toolNames(message.result) });
      }
    });
    send(initializeRequest);
  });
}

// ---- HTTP (streamable) and SSE --------------------------------------------------------------------

/** Server-sent events from a fetch body, as { event, data } pairs. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield { event, data };
      cut = buffer.indexOf('\n\n');
    }
  }
}

async function messageWithId(events: AsyncGenerator<{ event: string; data: string }>, id: number): Promise<Json> {
  for await (const { event, data } of events) {
    if (event !== 'message') continue;
    try {
      const message = JSON.parse(data) as Json;
      if (message.id === id) return message;
    } catch {
      // Not JSON: keep reading.
    }
  }
  throw new Error('the stream ended without an answer');
}

function httpFailure(response: Response): Error {
  const hint = response.status === 401 || response.status === 403 ? ' (check the token)' : '';
  return new Error(`the server answered ${response.status} ${response.statusText}${hint}`);
}

async function postRpc(url: string, headers: Record<string, string>, message: Json, signal: AbortSignal): Promise<{ reply?: Json; session?: string }> {
  const response = await fetch(url, {
    method: 'POST', signal, headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw httpFailure(response);
  const session = response.headers.get('mcp-session-id') ?? undefined;
  if (!('id' in message)) {
    await response.body?.cancel();
    return { session };
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream') && response.body) {
    const reply = await messageWithId(sseEvents(response.body), message.id as number);
    await response.body.cancel().catch(() => undefined);
    return { reply, session };
  }
  return { reply: (await response.json()) as Json, session };
}

async function probeStreamable(target: RemoteProbeTarget, signal: AbortSignal): Promise<McpTestResult> {
  const base = { ...target.headers };
  const init = await postRpc(target.url, base, initializeRequest, signal);
  const initError = init.reply && rpcError(init.reply);
  if (initError) return { ok: false, error: initError };
  const headers = { ...base, 'mcp-protocol-version': PROTOCOL_VERSION, ...(init.session ? { 'mcp-session-id': init.session } : {}) };
  await postRpc(target.url, headers, initializedNote, signal);
  const list = await postRpc(target.url, headers, toolsRequest, signal);
  if (init.session) {
    await fetch(target.url, { method: 'DELETE', headers, signal }).catch(() => undefined);
  }
  const listError = list.reply && rpcError(list.reply);
  return listError ? { ok: false, error: listError } : { ok: true, tools: toolNames(list.reply?.result) };
}

/** Legacy HTTP+SSE: GET opens the event stream, which names the endpoint to POST to; answers arrive on the stream. */
async function probeSse(target: RemoteProbeTarget, signal: AbortSignal): Promise<McpTestResult> {
  const stream = await fetch(target.url, { method: 'GET', signal, headers: { ...target.headers, accept: 'text/event-stream' } });
  if (!stream.ok || !stream.body) throw httpFailure(stream);
  const events = sseEvents(stream.body);
  let endpoint: string | undefined;
  for await (const { event, data } of events) {
    if (event === 'endpoint') {
      endpoint = new URL(data, target.url).toString();
      break;
    }
  }
  if (!endpoint) throw new Error('the server did not announce its message endpoint');
  if (new URL(endpoint).origin !== new URL(target.url).origin) throw new Error('the server announced an endpoint on another host');
  const post = async (message: Json) => {
    const response = await fetch(endpoint!, { method: 'POST', signal, headers: { ...target.headers, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    if (!response.ok) throw httpFailure(response);
    await response.body?.cancel();
  };
  await post(initializeRequest);
  const init = await messageWithId(events, 1);
  const initError = rpcError(init);
  if (initError) return { ok: false, error: initError };
  await post(initializedNote);
  await post(toolsRequest);
  const list = await messageWithId(events, 2);
  const listError = rpcError(list);
  return listError ? { ok: false, error: listError } : { ok: true, tools: toolNames(list.result) };
}

export async function probeRemote(target: RemoteProbeTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const secrets = Object.values(target.headers);
  try {
    return target.type === 'sse' ? await probeSse(target, controller.signal) : await probeStreamable(target, controller.signal);
  } catch (error) {
    const message = controller.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : (error as Error).message;
    return { ok: false, error: redact(`could not reach the server: ${message}`, secrets) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
