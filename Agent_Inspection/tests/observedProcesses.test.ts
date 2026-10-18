import { describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/collectors/processScanner.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/collectors/processScanner.ts')>();
  return {
    ...actual,
    scanProcesses: vi.fn(async () => [
      { pid: 50, ppid: 1, name: 'python.exe', commandLine: 'python -m aider', created: '' },
      { pid: 60, ppid: 1, name: 'codex.exe', commandLine: 'codex app-server', created: '' },
    ]),
  };
});

const { ProcessCollector } = await import('../daemon/collectors/observedProcesses.ts');
const { AgentRegistry } = await import('../daemon/domain/registry.ts');
const scanner = await import('../daemon/collectors/processScanner.ts');
const { makeAgent } = await import('./helpers.ts');

describe('ProcessCollector', () => {
  it('surfaces other CLI agents as stoppable observe-only agents', async () => {
    const registry = new AgentRegistry();
    const collector = new ProcessCollector(registry);
    await collector.start();
    collector.stop();
    expect(collector.latest()).toHaveLength(2);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: 'proc:50', vendor: 'other', tier: 'C', name: 'Aider', canInstruct: false }),
    ]);
  });

  it('keeps the previous snapshot when a scan fails', async () => {
    const registry = new AgentRegistry();
    const collector = new ProcessCollector(registry);
    await collector.scan();
    vi.mocked(scanner.scanProcesses).mockRejectedValueOnce(new Error('wmi down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await collector.scan();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(registry.list()).toHaveLength(1);
  });

  it('uses conversation records for Codex cards while retaining CLI processes for liveness', async () => {
    const registry = new AgentRegistry();
    const collector = new ProcessCollector(registry);
    const processes = [
      { pid: 70, ppid: 1, name: 'codex.exe', commandLine: 'codex', created: '' },
      { pid: 71, ppid: 1, name: 'codex.exe', commandLine: 'codex exec task', created: '' },
      { pid: 50, ppid: 1, name: 'python.exe', commandLine: 'python -m aider', created: '' },
    ];
    vi.mocked(scanner.scanProcesses).mockResolvedValueOnce(processes);
    await collector.scan();
    expect(collector.latest()).toEqual(processes);
    expect(registry.list().map(agent => agent.id)).toEqual(['proc:50']);

    const session = makeAgent({ id: 'codex:thread', vendor: 'codex', tier: 'C', sessionId: 'thread', cwd: 'C:/Projects/App' });
    registry.replaceSource('codex-sessions', [session]);
    vi.mocked(scanner.scanProcesses).mockResolvedValueOnce(processes);
    await collector.scan();
    expect(registry.list().filter(agent => agent.vendor === 'codex')).toEqual([session]);
    registry.replaceSource('codex-sessions', []);
    expect(registry.list().map(agent => agent.id)).toEqual(['proc:50']);
  });
});
