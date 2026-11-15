import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runFactoryCheck } from '../daemon/factory/checks.ts';
import { tempDir } from './helpers.ts';

function fixture(script: string) {
  const cwd = tempDir('factory-check-'); writeFileSync(join(cwd, 'verify.cjs'), script);
  return { cwd, check: { id: 'test', name: 'Behavior', command: 'node verify.cjs' } };
}
describe('factory executable check runner', () => {
  it('runs a real command in its assigned working directory and records output', async () => {
    const { cwd, check } = fixture('console.log(process.cwd()); console.log("behavior verified");');
    const evidence = await runFactoryCheck(check, cwd, 'revision-one', 5000, new AbortController().signal);
    expect(evidence.outcome).toBe('passed'); expect(evidence.output).toContain(cwd); expect(evidence.output).toContain('behavior verified'); expect(evidence.revision).toBe('revision-one');
  });
  it('preserves nonzero command failures', async () => {
    const { cwd, check } = fixture('console.error("regression"); process.exit(3);');
    const evidence = await runFactoryCheck(check, cwd, 'revision-two', 5000, new AbortController().signal);
    expect(evidence.outcome).toBe('failed'); expect(evidence.output).toContain('regression');
  });
  it('fails on nonexistent commands instead of recording success', async () => {
    const evidence = await runFactoryCheck({ id: 'missing', name: 'Missing', command: 'waystation_missing_executable_9284' }, tempDir(), 'rev', 5000, new AbortController().signal);
    expect(evidence.outcome).toBe('failed');
  });
  it('terminates a command that exceeds its timeout', async () => {
    const { cwd, check } = fixture('setInterval(() => {}, 1000);');
    const evidence = await runFactoryCheck(check, cwd, 'rev', 350, new AbortController().signal);
    expect(evidence.outcome).toBe('timed_out'); expect(evidence.finishedAt - evidence.startedAt).toBeLessThan(6000);
  });
  it('cancels a running check without treating cancellation as a pass', async () => {
    const { cwd, check } = fixture('setInterval(() => {}, 1000);'); const controller = new AbortController();
    const result = runFactoryCheck(check, cwd, 'rev', 8000, controller.signal); setTimeout(() => controller.abort(), 350);
    expect((await result).outcome).toBe('failed');
  });
  it('bounds captured output', async () => {
    const { cwd, check } = fixture('console.log("x".repeat(60000));');
    const evidence = await runFactoryCheck(check, cwd, 'rev', 5000, new AbortController().signal);
    expect(evidence.outcome).toBe('passed'); expect(evidence.output.length).toBeLessThanOrEqual(32000);
  });
});
