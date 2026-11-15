import { LibraryInputError } from '../library/types.ts';
import type { BrainConnection } from '../../shared/agentBrains.ts';
import type { JsonSchema } from '../../shared/agentResources.ts';

export interface AgentModelTool { name: string; description: string; parameters: JsonSchema; execute: (args: unknown) => Promise<unknown> }
export interface ModelRunOptions { model?: string; maxOutputTokens: number; signal?: AbortSignal; tools?: AgentModelTool[]; maxSteps?: number; maxToolCalls?: number; history?: { role: 'user' | 'assistant'; content: string }[]; onStep?: (message: string) => void; onUsage?: (usage: { inputTokens: number; outputTokens: number; toolCalls: number }) => void }
export async function runModelConversation(connection: Omit<BrainConnection, 'hasKey'>, key: string | undefined, role: string, input: string, options: ModelRunOptions, send: typeof fetch) {
  const anthropic = connection.provider === 'anthropic'; const openai = connection.provider === 'openai';
  const model = options.model?.trim() || connection.model; const tools = options.tools ?? [];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (anthropic) { headers['anthropic-version'] = '2026-10-21'; if (connection.workspaceId) headers['anthropic-workspace-id'] = connection.workspaceId; }
  const url = `${connection.baseUrl}/${anthropic ? 'messages' : openai ? 'responses' : 'chat/completions'}`;
  const signal = options.signal ?? new AbortController().signal;
  const prior = options.history ?? [];
  const history: any[] = [...(!openai && !anthropic ? [{ role: 'system', content: role }] : []), ...prior, { role: 'user', content: input }];
  const usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  for (let step = 0; step < Math.min(options.maxSteps ?? 8, 12); step++) {
    signal.throwIfAborted(); options.onStep?.(`Model turn ${step + 1}`);
    const remaining = options.maxOutputTokens - usage.outputTokens;
    if (remaining < 1) throw new LibraryInputError('The run reached its output-token budget before producing a final response.');
    const definitions = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const body = anthropic ? { model, max_tokens: remaining, system: role, messages: history, ...(tools.length ? { tools: definitions.map(({ parameters, ...t }) => ({ ...t, input_schema: parameters })) } : {}) }
      : openai ? { model, instructions: role, input: !tools.length && !step && !prior.length ? input : history, max_output_tokens: remaining, store: false, tools: definitions.map(t => ({ type: 'function', ...t, strict: false })) }
        : { model, messages: history, max_tokens: remaining, stream: false, ...(tools.length ? { tools: definitions.map(t => ({ type: 'function', function: t })) } : {}) };
    let response: Response;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    try { response = await send(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: requestSignal }); }
    catch { throw new LibraryInputError(requestSignal.aborted ? 'Provider request cancelled or timed out.' : 'Could not reach the LLM endpoint. Check the connection and retry.'); }
    if (!response.ok) { await response.body?.cancel(); throw new LibraryInputError(`LLM request failed (HTTP ${response.status}). Check the API key, model, endpoint, and provider limits.`); }
    const reader = response.body?.getReader(); if (!reader) throw new LibraryInputError('The provider returned an empty response.');
    const decoder = new TextDecoder(); let data = ''; let bytes = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 2_000_000) { await reader.cancel(); throw new Error('too large'); } data += decoder.decode(chunk.value, { stream: true }); } data += decoder.decode(); }
    catch { throw new LibraryInputError('The provider response was interrupted or too large.'); }
    let result: any; try { result = JSON.parse(data); } catch { throw new LibraryInputError('The endpoint did not return a JSON model response.'); }
    usage.inputTokens += Number(result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0) + (anthropic ? Number(result.usage?.cache_read_input_tokens ?? 0) : 0);
    usage.outputTokens += Number(result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0);
    options.onUsage?.({ ...usage });
    const content = anthropic ? (Array.isArray(result.content) ? result.content : []) : openai ? (Array.isArray(result.output) ? result.output : []) : [];
    const calls: { id: string; name: string; input: unknown }[] = anthropic ? content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ id: c.id, name: c.name, input: c.input }))
      : openai ? content.filter((c: any) => c.type === 'function_call').map((c: any) => ({ id: c.call_id, name: c.name, input: c.arguments }))
        : (result.choices?.[0]?.message?.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, input: c.function?.arguments }));
    if (calls.length) {
      if (usage.toolCalls + calls.length > (options.maxToolCalls ?? 20)) throw new LibraryInputError(`The run reached its ${options.maxToolCalls ?? 20}-tool-call limit.`);
      if (anthropic) history.push({ role: 'assistant', content }); else if (openai) history.push(...content); else history.push(result.choices[0].message);
      const returns: any[] = [];
      for (const call of calls) {
        signal.throwIfAborted(); usage.toolCalls++; options.onUsage?.({ ...usage });
        let value: unknown;
        try {
          const tool = tools.find(t => t.name === call.name); if (!tool) throw new LibraryInputError('This tool is not connected or permitted for this agent.');
          const args = typeof call.input === 'string' ? JSON.parse(call.input) : call.input;
          value = await tool.execute(args);
        } catch (e) { signal.throwIfAborted(); value = { error: e instanceof LibraryInputError ? e.message : 'Tool execution failed. Check the configuration and input.' }; }
        let serialized = JSON.stringify(value ?? null); if (key) serialized = serialized.split(key).join('[redacted]'); serialized = serialized.slice(0, 100000);
        if (anthropic) returns.push({ type: 'tool_result', tool_use_id: call.id, content: serialized });
        else if (openai) history.push({ type: 'function_call_output', call_id: call.id, output: serialized });
        else history.push({ role: 'tool', tool_call_id: call.id, content: serialized });
      }
      if (anthropic) history.push({ role: 'user', content: returns });
      continue;
    }
    let output = anthropic ? content.filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n')
      : openai ? content.flatMap((c: any) => Array.isArray(c.content) ? c.content : []).filter((c: any) => c.type === 'output_text' && typeof c.text === 'string').map((c: any) => c.text).join('\n')
        : typeof result.choices?.[0]?.message?.content === 'string' ? result.choices[0].message.content : '';
    if (!output.trim()) throw new LibraryInputError('The model returned no text. Check the model and output limit.');
    if (key) output = output.split(key).join('[redacted]');
    return { kind: 'api' as const, text: output.slice(0, 100000), model, usage, truncated: output.length > 100000 || result.status === 'incomplete' || result.stop_reason === 'max_tokens' || result.choices?.[0]?.finish_reason === 'length' };
  }
  throw new LibraryInputError('The run reached its model-turn limit. Review the activity and refine the task or tool configuration.');
}
