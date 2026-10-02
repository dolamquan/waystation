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
});
