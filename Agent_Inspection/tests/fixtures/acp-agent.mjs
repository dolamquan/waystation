// Deterministic ACP subprocess: no network, accounts or model calls.
import { createInterface } from 'node:readline';
let sessionId = `fixture-${process.pid}`, input = 0, output = 0, sequence = 0, held;
const replies = new Map();
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const request = (method, params) => new Promise(resolve => { const id = `client-${++sequence}`; replies.set(id, resolve); send({ id, method, params }); });
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (!message.method) { const resolve = replies.get(message.id); replies.delete(message.id); resolve?.(message); return; }
  const { method, params, id } = message;
  const reply = result => send({ id, result });
  if (method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: !process.argv.includes('--no-resume'), mcpCapabilities: { http: true } }, authMethods: [] });
  if (method === 'session/new' || method === 'session/load') {
    if (process.argv.includes('--signed-out')) return send({ id, error: { code: -32000, message: 'Authentication required' } });
    if (method === 'session/load') { sessionId = params.sessionId; input = 100; output = 20; }
    if (process.env.CAPTURE_ACP_CONFIG) {
      const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.CAPTURE_ACP_CONFIG, JSON.stringify(params));
    }
    return reply({ sessionId, configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default', options: [{ value: 'test-model', name: 'Test model' }] }] });
  }
  if (method === 'session/set_config_option') return reply({ configOptions: [] });
  if (method === 'session/cancel') { held?.({ stopReason: 'cancelled' }); held = undefined; return; }
  if (method === 'session/prompt') {
    const text = params.prompt.filter(block => block.type === 'text').at(-1).text;
    if (process.env.HOLD_ACP_PROMPTS || text === 'wait forever') { held = reply; return; }
    if (text === 'approval') {
      const result = await request('session/request_permission', { sessionId, toolCall: { toolCallId: 'tool-1', title: 'Run command', kind: 'execute', rawInput: { command: 'echo hello' } },
        options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' }] });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Permission: ${result.result?.outcome?.optionId ?? 'cancelled'}` } });
    } else if (text.startsWith('write:') || text.startsWith('read:')) {
      const write = text.startsWith('write:');
      const result = await request(write ? 'fs/write_text_file' : 'fs/read_text_file', { sessionId, path: text.slice(write ? 6 : 5), ...(write ? { content: 'written by ACP fixture' } : {}) });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.error ? 'File request denied' : 'File request succeeded' } });
    } else {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply to ' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    }
    update({ sessionUpdate: 'usage_update', used: 1234, size: 100000 });
    if (text !== 'no usage') { input += 100; output += 20; return reply({ stopReason: 'end_turn', usage: process.argv.includes('--turn-usage') ? { totalTokens: 120, inputTokens: 100, outputTokens: 20 } : { totalTokens: input + output, inputTokens: input, outputTokens: output } }); }
    return reply({ stopReason: 'end_turn' });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } });
});
