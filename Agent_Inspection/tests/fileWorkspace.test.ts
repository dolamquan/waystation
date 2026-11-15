import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editableFile, writeFolderFile } from '../daemon/files/fileEditing.ts';
import { WorkspaceRuntime } from '../daemon/files/workspaceRuntime.ts';

const root = mkdtempSync(join(tmpdir(), 'waystation-file-workspace-'));
const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' }, custom: { keep: true } }, cells: [{ id: 'one', cell_type: 'code', metadata: {}, execution_count: null, source: 'x = 40', outputs: [] }] };
beforeAll(() => {
  writeFileSync(join(root, 'main.py'), 'print("original")\r\n');
  writeFileSync(join(root, 'analysis.ipynb'), JSON.stringify(notebook));
  writeFileSync(join(root, 'script space;name.cjs'), 'console.log("real script result", 6 * 7);');
  writeFileSync(join(root, 'image.png'), Buffer.from([0, 1, 2]));
});

describe('file editing', () => {
  it('saves exact text and refuses a stale revision after an external edit', () => {
    const file = editableFile(root, 'main.py');
    expect('revision' in file).toBe(true);
    const revision = (file as { revision: string }).revision;
    const saved = writeFolderFile({ root, path: 'main.py', text: 'print("edited")\r\n', revision });
    expect(readFileSync(join(root, 'main.py'), 'utf8')).toBe('print("edited")\r\n');
    writeFileSync(join(root, 'main.py'), 'print("agent changed this")\n');
    expect(() => writeFolderFile({ root, path: 'main.py', text: 'overwrite', revision: saved.revision })).toThrow(/changed on disk/);
    expect(readFileSync(join(root, 'main.py'), 'utf8')).toContain('agent changed');
  });
  it('saves notebook outputs while preserving metadata and rejects malformed notebooks', () => {
    const file = editableFile(root, 'analysis.ipynb') as { revision: string };
    expect(() => writeFolderFile({ root, path: 'analysis.ipynb', text: '{bad', revision: file.revision })).toThrow(/JSON/);
    const next = { ...notebook, cells: [{ ...notebook.cells[0], source: 'x = 42', execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: '42\n' }] }] };
    writeFolderFile({ root, path: 'analysis.ipynb', text: JSON.stringify(next), revision: file.revision });
    expect(JSON.parse(readFileSync(join(root, 'analysis.ipynb'), 'utf8'))).toEqual(next);
  });
  it('refuses path escapes, .git writes and image overwrite', () => {
    for (const path of ['../outside.py', '.git/config', 'image.png']) expect(() => writeFolderFile({ root, path, text: 'bad', revision: 'x' })).toThrow();
  });
});

describe('real file runtimes', () => {
  const runtime = new WorkspaceRuntime();
  afterAll(() => runtime.dispose());
  const finished = async (id: string) => {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const state = runtime.get(id);
      if (state.status !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Execution did not finish.');
  };
  it('runs a real Node script with spaces and metacharacters in its filename', async () => {
    const state = runtime.run({ root, path: 'script space;name.cjs' });
    const result = await finished(state.id);
    expect(result.exitCode).toBe(0);
    expect(result.outputs.map((output) => output.text).join('')).toContain('real script result 42');
    runtime.close(state.id);
  });
  it('executes notebook cells in one real Jupyter kernel, retaining variables and rich outputs', async () => {
    const state = await runtime.startKernel({ root, path: 'analysis.ipynb', kernel: 'python3' });
    expect(state.status).toBe('idle');
    runtime.execute(state.id, 'value = 40\nprint("first cell")');
    expect((await finished(state.id)).outputs.some((output) => String(output.text).includes('first cell'))).toBe(true);
    runtime.execute(state.id, 'value + 2');
    const second = await finished(state.id);
    expect(second.outputs.some((output) => output.data?.['text/plain'] === '42')).toBe(true);
    expect(second.count).toBe(2);
    runtime.execute(state.id, 'from IPython.display import display, HTML\ndisplay(HTML("<table><tr><td>Rich result</td></tr></table>"))');
    expect((await finished(state.id)).outputs.some((output) => output.data?.['text/html']?.includes('Rich result'))).toBe(true);
    runtime.execute(state.id, 'raise ValueError("visible cell error")');
    expect((await finished(state.id)).outputs.some((output) => output.output_type === 'error' && output.evalue === 'visible cell error')).toBe(true);
    runtime.execute(state.id, 'import time\ntime.sleep(30)');
    await new Promise((resolve) => setTimeout(resolve, 700)); runtime.interrupt(state.id);
    expect((await finished(state.id)).outputs.some((output) => output.ename === 'KeyboardInterrupt')).toBe(true);
    runtime.close(state.id);
  }, 70_000);
});
