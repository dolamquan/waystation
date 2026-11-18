import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { LibraryDeps } from '../library/deps.ts';
import { LibraryInputError } from '../library/types.ts';
import { folderRoot } from '../files/folderFiles.ts';
import { folder } from '../../web/src/stationOffices.ts';
import { DEFAULT_SANDBOX, validateSandbox, type SandboxConfig, type SandboxExecution } from '../../shared/agentEvaluation.ts';

type CommandResult = { code: number; stdout: string; stderr: string };
export type SandboxCommand = (args: string[], input: string, signal: AbortSignal, timeoutMs: number) => Promise<CommandResult>;
export const sandboxImage = (language: SandboxConfig['language']) => language === 'javascript' ? 'node:22-alpine' : 'python:3.12-alpine';
const dockerCommand: SandboxCommand = (args, input, signal, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let settled = false;
  const finish = (error?: Error, code = 1) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { child.kill(); reject(error); } else resolve({ code, stdout, stderr }); };
  const abort = () => finish(new Error('Sandbox execution cancelled.')); const timer = setTimeout(() => finish(new Error('Sandbox execution timed out.')), timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 100000) finish(new Error('Sandbox output exceeds 100 KB.')); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100000) finish(new Error('Sandbox error output exceeds 100 KB.')); });
  child.on('error', () => finish(new Error('Docker is unavailable. Start Docker Desktop and pull the selected runtime image.'))); child.on('close', code => finish(undefined, code ?? 1));
  child.stdin.on('error', () => {}); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); else child.stdin.end(input);
});

export class AgentSandboxes {
  private readonly controllers = new Map<string, AbortController>(); private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly deps: LibraryDeps, private readonly clean: (project: string, text: string) => string, private readonly command: SandboxCommand = dockerCommand) {}
  recover(): void { for (const row of this.deps.store.loadRecords<SandboxExecution>('agent_sandboxes')) if (row.status === 'running' && !this.controllers.has(row.id)) this.deps.store.saveRecord('agent_sandboxes', { ...row, status: 'interrupted', finishedAt: Date.now(), error: 'Daemon restarted during execution. Start a new sandbox attempt.' }); }
  list(project: string): SandboxExecution[] { return this.deps.store.loadRecords<SandboxExecution>('agent_sandboxes').filter(r => folder(r.project)?.key === folder(project)?.key).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100); }
  get(id: string): SandboxExecution { const row = this.deps.store.loadRecord<SandboxExecution>('agent_sandboxes', id); if (!row) throw new LibraryInputError('Sandbox execution not found.'); return row; }
  async availability(): Promise<{ docker: boolean; message: string; images: string[] }> {
    try { const result = await this.command(['info', '--format', '{{.ServerVersion}}'], '', new AbortController().signal, 5000); return { docker: result.code === 0, message: result.code === 0 ? `Docker engine ${result.stdout.trim()}` : 'Docker engine is not running. Start Docker Desktop to use container sandboxes.', images: ['node:22-alpine', 'python:3.12-alpine'] }; }
    catch { return { docker: false, message: 'Docker engine is unavailable. Start Docker Desktop; the JavaScript interpreter is available independently.', images: ['node:22-alpine', 'python:3.12-alpine'] }; }
  }
  start(project: string, raw: Record<string, unknown>, runId?: string, signal?: AbortSignal): SandboxExecution {
    let root: string; let config: SandboxConfig; try { root = folderRoot(project); config = validateSandbox(raw.config ?? DEFAULT_SANDBOX); } catch (e) { throw new LibraryInputError((e as Error).message); }
    if (typeof raw.code !== 'string' || !raw.code.trim() || raw.code.length > 20000) throw new LibraryInputError('Enter code between 1 and 20000 characters.');
    if (JSON.stringify(raw.input ?? null).length > 32000) throw new LibraryInputError('Sandbox input must fit in 32 KB.'); if (this.controllers.size >= 4) throw new LibraryInputError('Four sandboxes are running. Finish or cancel one first.');
    const row: SandboxExecution = { id: randomUUID(), project: root, runId, config, status: 'running', code: this.clean(root, raw.code), input: JSON.parse(this.clean(root, JSON.stringify(raw.input ?? null))), stdout: '', stderr: '', createdAt: Date.now() };
    this.deps.store.saveRecord('agent_sandboxes', row); const controller = new AbortController(); this.controllers.set(row.id, controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    const job = this.executeRecord(row, raw.code, raw.input ?? null, controller.signal).finally(() => { signal?.removeEventListener('abort', abort); this.controllers.delete(row.id); this.jobs.delete(row.id); }); this.jobs.set(row.id, job); return row;
  }
  async execute(project: string, config: SandboxConfig, code: string, input: unknown, runId?: string, signal?: AbortSignal): Promise<SandboxExecution> { const row = this.start(project, { config, code, input }, runId, signal); await this.jobs.get(row.id); return this.get(row.id); }
  private async executeRecord(row: SandboxExecution, code: string, input: unknown, signal: AbortSignal): Promise<void> {
    const container = `waystation-sandbox-${row.id}`;
    try {
      signal.throwIfAborted();
      if (row.config.backend === 'quickjs') {
        const engine = await getQuickJS(); const result = engine.evalCode(`(()=>{const result=(function(input){"use strict";\n${code}\n})(${JSON.stringify(input)});if(result&&typeof result.then==='function')throw new Error('Return a synchronous JSON value');return JSON.stringify(result??null);})()`, { shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + row.config.timeoutMs), memoryLimitBytes: row.config.memoryMb * 1024 * 1024, maxStackSizeBytes: 512 * 1024 });
        if (typeof result !== 'string' || result.length > 100000) throw new Error('Return a JSON value under 100 KB.'); row.output = JSON.parse(this.clean(row.project, result)); row.stdout = JSON.stringify(row.output, null, 2); row.exitCode = 0;
      } else {
        const wrapper = row.config.language === 'python' ? 'import sys,json\np=json.loads(sys.stdin.read())\nexec(p["code"],{"input":p["input"]})' : 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")); const result=new Function("input",p.code)(p.input); if(result!==undefined) console.log(JSON.stringify(result));';
        const interpreter = row.config.language === 'shell' ? ['sh', '-s'] : row.config.language === 'python' ? ['python3', '-I', '-c', wrapper] : ['node', '-e', wrapper];
        const runtime = ['--entrypoint', '/bin/busybox', sandboxImage(row.config.language), 'timeout', '-s', 'KILL', String(Math.ceil(row.config.timeoutMs / 1000)), ...interpreter];
        const args = ['run', '--rm', '--pull', 'never', '--name', container, '--label', 'waystation.sandbox=true', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '64', '--memory', `${row.config.memoryMb}m`, '--memory-swap', `${row.config.memoryMb}m`, '--cpus', '1', '--tmpfs', '/workspace:rw,size=64m,uid=65534,gid=65534,mode=700', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--workdir', '/workspace', ...(row.config.language === 'shell' ? ['--env', `INPUT_JSON=${JSON.stringify(input)}`] : []), '-i', ...runtime];
        const result = await this.command(args, row.config.language === 'shell' ? code : JSON.stringify({ code, input }), signal, row.config.timeoutMs);
        row.stdout = this.clean(row.project, result.stdout).slice(0, 100000); row.stderr = this.clean(row.project, result.stderr).slice(0, 100000); row.exitCode = result.code; if (result.code !== 0) throw new Error(result.code === 125 ? 'Container could not start. Start Docker Desktop and pull the selected runtime image.' : `Sandbox exited with code ${result.code}.`);
      }
      signal.throwIfAborted(); row.status = 'succeeded';
    } catch (e) { row.status = signal.aborted ? 'cancelled' : 'failed'; row.error = this.clean(row.project, row.config.backend === 'quickjs' ? 'JavaScript failed or exceeded its time/memory limits. Return a synchronous JSON value; host APIs are unavailable.' : (e as Error).message).slice(0, 1000); }
    finally {
      if (row.config.backend === 'docker') await this.command(['rm', '-f', container], '', new AbortController().signal, 5000).catch(() => {});
      if (this.get(row.id).status !== 'interrupted') { row.finishedAt = Date.now(); this.deps.store.saveRecord('agent_sandboxes', row); }
    }
  }
  /**
   * Evaluator code path: runs a JavaScript function body in a fresh QuickJS context, in memory. It is not
   * persisted and does not count against the four-execution cap, so graders cannot fail spuriously under load.
   * Errors from the evaluator's own code are surfaced (sanitized) so authors can fix them.
   */
  async evaluateJavaScript(project: string, code: string, input: unknown, timeoutMs = DEFAULT_SANDBOX.timeoutMs, memoryMb = DEFAULT_SANDBOX.memoryMb): Promise<unknown> {
    const engine = await getQuickJS();
    let result: unknown;
    try {
      result = engine.evalCode(`(()=>{const result=(function(input){"use strict";\n${code}\n})(${JSON.stringify(input)});if(result&&typeof result.then==='function')throw new Error('Return a synchronous JSON value');return JSON.stringify(result??null);})()`, { shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeoutMs), memoryLimitBytes: memoryMb * 1024 * 1024, maxStackSizeBytes: 512 * 1024 });
    } catch (e) {
      // QuickJS rethrows guest errors as plain {name, message, stack} objects, not Error instances.
      const detail = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      throw new LibraryInputError(`Evaluator code failed: ${this.clean(project, detail).slice(0, 300)}`);
    }
    if (typeof result !== 'string' || result.length > 100000) throw new LibraryInputError('Evaluator code must return a JSON value under 100 KB.');
    return JSON.parse(result);
  }
  cancel(id: string): SandboxExecution { const row = this.get(id); if (row.status !== 'running') throw new LibraryInputError('This sandbox has already finished.'); this.controllers.get(id)?.abort(); return row; }
  async shutdown(): Promise<void> { for (const [id, controller] of this.controllers) { const row = this.get(id); this.deps.store.saveRecord('agent_sandboxes', { ...row, status: 'interrupted', finishedAt: Date.now(), error: 'Daemon stopped during sandbox execution.' }); controller.abort(); } await Promise.allSettled([...this.jobs.values()]); }
}
