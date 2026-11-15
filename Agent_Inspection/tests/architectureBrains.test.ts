import { describe, expect, it, vi } from 'vitest';
import { BrainConnections, brainBaseUrl } from '../daemon/architecture/brains.ts';
import { TowerStore } from '../daemon/store/db.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import { tempDir } from './helpers.ts';
import type { BrainProvider } from '../shared/agentBrains.ts';

describe('LLM connection credentials and request adapters', () => {
  it('keeps keys out of records and views, supports replacement, and isolates projects', () => {
    const db = new TowerStore(':memory:'); const secrets = new SecretStore(':memory:'); const audit = vi.fn();
    const brains = new BrainConnections({ store: db, secrets, audit, paths: {} as any });
    const project = tempDir();
    try {
      const connection = brains.create(project, { label: 'Research', provider: 'openai', model: 'test-model', apiKey: 'private-test-key-123' });
      expect(connection.hasKey).toBe(true); expect(JSON.stringify(connection)).not.toContain('private-test-key-123');
      expect(JSON.stringify(db.loadRecords('brain_connections'))).not.toContain('private-test-key-123');
      expect(JSON.stringify(audit.mock.calls)).not.toContain('private-test-key-123');
      expect(brains.list(tempDir())).toEqual([]);
      expect(() => brains.replaceKey(connection.id, tempDir(), 'other-key')).toThrow(/not found/);
      brains.replaceKey(connection.id, project, 'replacement-private-key');
      expect(secrets.get(`architecture-brain:${connection.id}:apiKey`)).toBe('replacement-private-key');
      expect(() => brains.create(project, { label: 'Missing', provider: 'anthropic', model: 'model' })).toThrow(/key/);
      expect(() => brains.create(project, { label: 'Bad', provider: 'openai', model: 'model', apiKey: 'key\nheader' })).toThrow(/single line/);
    } finally { db.close(); }
  });
  it('uses the correct wire format for each provider, exposes no tools, bounds output, and scrubs echoed credentials', async () => {
    for (const provider of ['openai', 'anthropic', 'compatible'] as BrainProvider[]) {
      const db = new TowerStore(':memory:'); const secrets = new SecretStore(':memory:'); const key = `private-${provider}-test-key`;
      const reply = provider === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `Answer ${key}` }] }] }
        : provider === 'anthropic' ? { content: [{ type: 'text', text: `Answer ${key}` }], stop_reason: 'max_tokens' }
          : { choices: [{ message: { content: `Answer ${key}` }, finish_reason: 'stop' }] };
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(reply), { status: 200 }));
      const brains = new BrainConnections({ store: db, secrets, audit: vi.fn(), paths: {} as any }, send);
      const project = tempDir();
      try {
        const connection = brains.create(project, { label: 'Brain', provider, model: 'test-model', apiKey: key, baseUrl: 'http://127.0.0.1:12345/v1', workspaceId: 'wrkspc_test' });
        const result = await brains.run(connection.id, project, 'Research documents.', 'Explain a plan.', { maxOutputTokens: 256 });
        expect(result.text).toBe('Answer [redacted]'); expect(result.model).toBe('test-model');
        const [endpoint, init] = send.mock.calls[0]; const body = JSON.parse(init!.body as string); const headers = init!.headers as Record<string, string>;
        expect(endpoint).toContain(provider === 'openai' ? '/v1/responses' : provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
        expect(JSON.stringify(body)).not.toContain(key); expect(body.tools ?? []).toEqual([]); expect(init!.redirect).toBe('error');
        if (provider === 'anthropic') { expect(headers.authorization).toBe(`Bearer ${key}`); expect(headers['anthropic-version']).toBe('2026-10-21'); expect(headers['anthropic-workspace-id']).toBe('wrkspc_test'); expect(body.max_tokens).toBe(256); expect(body.system).toBe('Research documents.'); expect(result.truncated).toBe(true); }
        else { expect(headers.authorization).toBe(`Bearer ${key}`); expect(body.max_tokens ?? body.max_output_tokens).toBe(256); }
        await expect(brains.run(connection.id, tempDir(), '', '', { maxOutputTokens: 64 })).rejects.toThrow(/not found/);
      } finally { db.close(); }
    }
  });
  it('does not echo upstream error bodies or network exceptions and permits keyless compatible endpoints', async () => {
    const db = new TowerStore(':memory:'); const send = vi.fn<typeof fetch>(); const project = tempDir();
    const brains = new BrainConnections({ store: db, secrets: new SecretStore(':memory:'), audit: vi.fn(), paths: {} as any }, send);
    try {
      const connection = brains.create(project, { label: 'Local', provider: 'compatible', model: 'local', baseUrl: 'http://localhost:11434/v1' });
      expect(connection.hasKey).toBe(false);
      send.mockResolvedValueOnce(new Response('private-key-in-provider-error', { status: 401 }));
      await expect(brains.run(connection.id, project, 'role', 'input', { maxOutputTokens: 64 })).rejects.toThrow(/^LLM request failed \(HTTP 401\)/);
      send.mockRejectedValueOnce(new Error('private-key-in-network-error'));
      await expect(brains.run(connection.id, project, 'role', 'input', { maxOutputTokens: 64 })).rejects.toThrow(/^Could not reach/);
      for (const value of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?api_key=secret', 'file:///tmp/key']) expect(() => brainBaseUrl('compatible', value)).toThrow();
    } finally { db.close(); }
  });
});
