import { describe, expect, it, vi } from 'vitest';
import { runModelConversation } from '../daemon/architecture/modelLoop.ts';
import type { BrainProvider } from '../shared/agentBrains.ts';

describe('tool round trips in LLM APIs', () => {
  for (const provider of ['openai', 'anthropic', 'compatible'] as BrainProvider[]) it(`includes prior conversation turns in ${provider} requests without tools`, async () => {
    const last = provider === 'openai' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Oslo' }] }] } : provider === 'anthropic' ? { content: [{ type: 'text', text: 'Oslo' }] } : { choices: [{ message: { content: 'Oslo' } }] };
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(last)));
    const history = [{ role: 'user' as const, content: 'My city is Oslo' }, { role: 'assistant' as const, content: 'I will remember Oslo.' }];
    await runModelConversation({ id: 'c', project: 'p', label: 'c', provider, baseUrl: 'https://example.test/v1', model: 'model', createdAt: 1 }, undefined, 'Role', 'Which city?', { maxOutputTokens: 64, history }, send);
    const body = JSON.parse(String(send.mock.calls[0][1]!.body)); const turns = body.input ?? body.messages;
    expect(turns.filter((m: any) => m.role !== 'system')).toEqual([...history, { role: 'user', content: 'Which city?' }]);
  });
  it('enforces the saved tool-call budget before executing a model-requested action', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call', function: { name: 'allowed', arguments: '{}' } }] } }] })));
    const execute = vi.fn();
    await expect(runModelConversation({ id: 'c', project: 'p', label: 'c', provider: 'compatible', baseUrl: 'https://example.test/v1', model: 'model', createdAt: 1 }, undefined, 'Role', 'Task', { maxOutputTokens: 64, maxToolCalls: 0, tools: [{ name: 'allowed', description: '', parameters: { type: 'object' }, execute }] }, send)).rejects.toThrow(/0-tool-call limit/);
    expect(execute).not.toHaveBeenCalled();
  });
  for (const provider of ['openai', 'anthropic', 'compatible'] as BrainProvider[]) it(`executes a bounded ${provider} tool round trip and returns its result to the model`, async () => {
    const first = provider === 'openai' ? { output: [{ type: 'function_call', call_id: 'call-1', name: 'increment', arguments: '{"n":2}' }], usage: { input_tokens: 5, output_tokens: 2 } }
      : provider === 'anthropic' ? { content: [{ type: 'tool_use', id: 'call-1', name: 'increment', input: { n: 2 } }], usage: { input_tokens: 5, output_tokens: 2 } }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'increment', arguments: '{"n":2}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    const last = provider === 'openai' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: '3' }] }], usage: { input_tokens: 10, output_tokens: 1 } }
      : provider === 'anthropic' ? { content: [{ type: 'text', text: '3' }], usage: { input_tokens: 10, output_tokens: 1 } }
        : { choices: [{ message: { content: '3' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(first))).mockResolvedValueOnce(new Response(JSON.stringify(last)));
    const execute = vi.fn(async (input: any) => ({ answer: input.n + 1 })); const onUsage = vi.fn();
    const result = await runModelConversation({ id: 'c', project: 'p', label: 'c', provider, baseUrl: 'https://example.test/v1', model: 'model', createdAt: 1 }, 'test-key', 'Role', 'Task', { maxOutputTokens: 64, tools: [{ name: 'increment', description: 'Add one', parameters: { type: 'object' }, execute }], onUsage }, send);
    expect(execute).toHaveBeenCalledWith({ n: 2 }); expect(result.text).toBe('3'); expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 3, toolCalls: 1 });
    const second = JSON.parse(send.mock.calls[1][1]!.body as string); expect(JSON.stringify(second)).toContain('answer'); expect(JSON.stringify(second)).toContain('call-1'); expect(onUsage).toHaveBeenCalledWith({ inputTokens: 15, outputTokens: 3, toolCalls: 1 });
    expect(second.max_output_tokens ?? second.max_tokens).toBe(62);
  });
  it('does not execute disconnected tools and enforces its turn limit', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'not_connected', arguments: '{}' } }] } }] })));
    const execute = vi.fn();
    await expect(runModelConversation({ id: 'c', project: 'p', label: 'c', provider: 'compatible', baseUrl: 'http://localhost/v1', model: 'model', createdAt: 1 }, undefined, '', '', { maxOutputTokens: 64, maxSteps: 2, tools: [{ name: 'allowed', description: '', parameters: {}, execute }] }, send)).rejects.toThrow(/turn limit/);
    expect(execute).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(2);
  });
});
