import { describe, expect, it } from 'vitest';
import { classifyObserved, hasCodexBackend, parseProcessJson, type ProcInfo } from '../daemon/collectors/processScanner.ts';

const proc = (pid: number, name: string, commandLine = '', ppid = 1): ProcInfo => ({ pid, ppid, name, commandLine, created: '' });

describe('process classification', () => {
  it('excludes editor-hosted Codex backends but includes standalone Codex CLI', () => {
    const procs = [
      proc(10, 'codex.exe', 'c:\\Users\\me\\.vscode\\extensions\\openai.chatgpt\\bin\\codex.exe app-server'),
      proc(11, 'codex.exe', '"C:\\Users\\me\\.codex\\packages\\app-server-daemon\\codex.exe" app-server --listen'),
      proc(12, 'codex.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe'),
    ];
    expect(classifyObserved(procs)).toEqual([{ pid: 12, vendor: 'codex', label: 'Codex CLI' }]);
    expect(hasCodexBackend(procs)).toBe(true);
  });

  it('ignores shells whose command line only mentions agent names', () => {
    expect(classifyObserved([proc(20, 'powershell.exe', "Where-Object { $_.CommandLine -match 'aider|gemini' }")])).toEqual([]);
    expect(classifyObserved([proc(21, 'claude.exe', 'claude --resume')])).toEqual([]);
  });

  it('detects other CLIs and folds children into their parent', () => {
    const procs = [proc(30, 'python.exe', 'python -m aider'), proc(31, 'python.exe', 'python aider worker', 30), proc(40, 'node.exe', 'node gemini-cli/index.js')];
    expect(classifyObserved(procs)).toEqual([
      { pid: 30, vendor: 'other', label: 'Aider' },
      { pid: 40, vendor: 'other', label: 'Gemini CLI' },
    ]);
  });

  it('parses PowerShell JSON for one or many processes', () => {
    expect(parseProcessJson('')).toEqual([]);
    expect(parseProcessJson('{"pid":5,"ppid":1,"name":"codex.exe","cmd":"x","created":"y"}')).toHaveLength(1);
    expect(parseProcessJson('[{"pid":5},{"pid":6},{"nopid":true}]')).toHaveLength(2);
  });
});
