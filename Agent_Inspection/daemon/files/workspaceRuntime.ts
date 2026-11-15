import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { consoleEnv } from '../pty/ptyManager.ts';
import { resolveInsideCwd } from '../outputs/pathSafety.ts';
import { FolderFileError, folderRoot, readFolderFile } from './folderFiles.ts';
import { stopProcessTree } from '../actions/kill.ts';

export interface ExecutionState {
  id: string; kind: 'kernel' | 'script'; status: 'starting' | 'idle' | 'running' | 'stopped' | 'error';
  job?: string; count?: number; outputs: Record<string, any>[]; error?: string; exitCode?: number | null;
  kernel?: string; root: string; path: string;
}
interface Entry { state: ExecutionState; child: ChildProcessWithoutNullStreams; touched: number }
const BRIDGE = fileURLToPath(new URL('./kernel_bridge.py', import.meta.url));
const python = () => process.env.WAYSTATION_PYTHON || 'python';
const MAX_SESSIONS = 8;

export class WorkspaceRuntime {
  private entries = new Map<string, Entry>();
  private timer = setInterval(() => {
    for (const [id, entry] of this.entries) if (Date.now() - entry.touched > 30 * 60_000 && entry.state.status !== 'running') this.close(id);
  }, 60_000).unref();

  private room() {
    for (const [id, entry] of this.entries) if (entry.state.status === 'stopped' || entry.state.status === 'error') this.entries.delete(id);
    if (this.entries.size >= MAX_SESSIONS) throw new FolderFileError('Eight file runtimes are already open. Stop a kernel or script before starting another.');
  }
  get(id: string): ExecutionState {
    const entry = this.entries.get(id);
    if (!entry) throw new FolderFileError('This runtime is no longer available. Start it again.');
    entry.touched = Date.now(); return entry.state;
  }
  async kernels(): Promise<{ name: string; label: string; language: string }[]> {
    return new Promise((resolve, reject) => execFile(python(), ['-u', BRIDGE, '--list'], { windowsHide: true, timeout: 15_000, env: consoleEnv(process.env) }, (error, stdout) => {
      try { const result = JSON.parse(stdout.trim()); if (error || result.error) throw new Error(result.error || error?.message); resolve(result.kernels); }
      catch (failure) { reject(new FolderFileError(`Could not list Jupyter kernels: ${(failure as Error).message}`)); }
    }));
  }
  async startKernel(raw: Record<string, unknown>): Promise<ExecutionState> {
    this.room();
    const root = folderRoot(raw.root), file = readFolderFile(root, raw.path);
    if (file.kind !== 'notebook') throw new FolderFileError('Choose a Jupyter notebook to start a kernel.');
    const kernel = typeof raw.kernel === 'string' && /^[\w. -]{1,100}$/.test(raw.kernel) ? raw.kernel : 'python3';
    const safe = resolveInsideCwd(root, raw.path), id = randomUUID();
    const child = spawn(python(), ['-u', BRIDGE, dirname(safe.abs), kernel], { windowsHide: true, env: consoleEnv(process.env) });
    const entry: Entry = { state: { id, root, path: file.path, kind: 'kernel', status: 'starting', kernel, outputs: [] }, child, touched: Date.now() };
    this.entries.set(id, entry);
    return new Promise((resolve, reject) => {
      let stderr = '';
      const fail = (message: string) => { entry.state.status = 'error'; entry.state.error = message; reject(new FolderFileError(message)); };
      const timeout = setTimeout(() => { this.close(id); fail('The kernel did not start within 35 seconds. Check the selected environment.'); }, 35_000);
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'ready') { clearTimeout(timeout); entry.state.status = 'idle'; resolve(entry.state); }
          else if (event.type === 'fatal') { clearTimeout(timeout); fail(event.error); }
          else if (event.job === entry.state.job) {
            if (event.type === 'count') entry.state.count = event.count;
            else if (event.type === 'output') {
              if (event.output.output_type === 'clear_output') entry.state.outputs = [];
              else entry.state.outputs.push(event.output);
            } else if (event.type === 'done') entry.state.status = 'idle';
            else if (event.type === 'error') { entry.state.status = 'idle'; entry.state.error = event.error; }
          }
        } catch { /* Kernel stdout is forwarded through protocol output, not parsed as commands. */ }
      });
      child.on('error', (error) => { clearTimeout(timeout); fail(`Cannot start Python: ${error.message}`); this.entries.delete(id); });
      child.on('exit', () => { clearTimeout(timeout); if (entry.state.status !== 'stopped') { fail(stderr || 'The Jupyter kernel process exited. Restart it to continue.'); } });
    });
  }
  execute(id: string, raw: unknown) {
    const state = this.get(id), entry = this.entries.get(id)!;
    if (state.kind !== 'kernel' || state.status !== 'idle') throw new FolderFileError('Wait for the running cell, or restart the kernel.');
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200_000) throw new FolderFileError('Choose a non-empty code cell under 200,000 characters.');
    state.job = randomUUID(); state.status = 'running'; state.outputs = []; delete state.error;
    entry.child.stdin.write(JSON.stringify({ op: 'execute', code: raw, job: state.job }) + '\n');
    return state;
  }
  interrupt(id: string) {
    const state = this.get(id), entry = this.entries.get(id)!;
    if (state.kind === 'kernel') entry.child.stdin.write('{"op":"interrupt"}\n');
    else this.close(id);
    return state;
  }
  run(raw: Record<string, unknown>): ExecutionState {
    this.room();
    const root = folderRoot(raw.root), file = readFolderFile(root, raw.path), safe = resolveInsideCwd(root, raw.path), ext = extname(safe.abs).toLowerCase();
    if (file.kind !== 'text') throw new FolderFileError('Choose a Python, JavaScript or TypeScript script to run.');
    const venv = join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    let command: string, args: string[];
    if (ext === '.py') { command = process.env.WAYSTATION_PYTHON || (existsSync(venv) ? venv : 'python'); args = ['-u', safe.abs]; }
    else if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) { command = process.execPath; args = [...(ext === '.ts' ? ['--experimental-strip-types'] : []), safe.abs]; }
    else throw new FolderFileError('Use the terminal to run this file type. Run file supports .py, .js, .mjs, .cjs and .ts.');
    const id = randomUUID(), child = spawn(command, args, { cwd: root, windowsHide: true, env: consoleEnv(process.env) });
    const entry: Entry = { child, touched: Date.now(), state: { id, root, path: file.path, kind: 'script', status: 'running', outputs: [] } };
    this.entries.set(id, entry);
    let size = 0;
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', (data) => {
      if (size > 1_000_000) return; size += data.length;
      entry.state.outputs.push({ output_type: 'stream', name, text: data.toString().slice(0, 50_000) });
    });
    child.on('error', (error) => { entry.state.status = 'error'; entry.state.error = error.message; });
    child.on('exit', (code) => { entry.state.status = 'stopped'; entry.state.exitCode = code; });
    return entry.state;
  }
  close(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    entry.state.status = 'stopped';
    if (entry.state.kind === 'kernel') {
      entry.child.stdin.end('{"op":"shutdown"}\n');
      setTimeout(() => { if (entry.child.exitCode === null) entry.child.kill(); }, 5000).unref();
    } else if (process.platform === 'win32' && entry.child.pid && entry.child.exitCode === null) void stopProcessTree(entry.child.pid).catch(() => entry.child.kill());
    else entry.child.kill();
    this.entries.delete(id);
  }
  dispose() { clearInterval(this.timer); for (const id of this.entries.keys()) this.close(id); }
}
export const workspaceRuntime = new WorkspaceRuntime();
