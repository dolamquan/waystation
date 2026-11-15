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
      { pid: 30, vendor: 'other', label: 'Aider', providerId: 'aider', host: 'cli' },
      { pid: 40, vendor: 'other', label: 'Gemini CLI', providerId: 'gemini', host: 'cli' },
    ]);
  });

  it('parses PowerShell JSON for one or many processes', () => {
    expect(parseProcessJson('')).toEqual([]);
    expect(parseProcessJson('{"pid":5,"ppid":1,"name":"codex.exe","cmd":"x","created":"y"}')).toHaveLength(1);
    expect(parseProcessJson('[{"pid":5},{"pid":6},{"nopid":true}]')).toHaveLength(2);
  });

  it('detects Copilot CLI, npm entry scripts and the shared editor runtime without counting its host', () => {
    expect(classifyObserved([
      proc(9, 'Code.exe', 'Code.exe'),
      proc(50, 'copilot-runtime.exe', 'copilot-runtime.exe', 9),
      proc(51, 'node.exe', 'node "C:\\npm\\node_modules\\@github\\copilot\\index.js"'),
      proc(52, 'copilot.exe', 'copilot --prompt "aider"'),
      proc(53, 'node.exe', 'node app.js --prompt "copilot aider goose"'),
      proc(54, 'node.exe', 'node C:/my-aider-project/app.js'),
    ])).toEqual([
      { pid: 50, vendor: 'other', label: 'GitHub Copilot', providerId: 'copilot', host: 'editor' },
      { pid: 51, vendor: 'other', label: 'GitHub Copilot', providerId: 'copilot', host: 'cli' },
      { pid: 52, vendor: 'other', label: 'GitHub Copilot', providerId: 'copilot', host: 'cli' },
    ]);
  });

  it('folds same-provider grandchildren through a shell, preserves other providers, and tolerates ancestry cycles', () => {
    expect(classifyObserved([
      proc(10, 'copilot.exe'), proc(11, 'cmd.exe', '', 10), proc(12, 'copilot-runtime.exe', '', 11),
      proc(13, 'goose.exe', '', 10), proc(14, 'amp.exe', '', 15), proc(15, 'node.exe', '', 14),
    ]).map(agent => agent.pid)).toEqual([10, 13, 14]);
  });

  it('supports custom executable and package signatures without inspecting prompt arguments', () => {
    const rule = { id: 'custom-test', label: 'My Agent', executables: ['my-agent'], packages: ['@example/my-agent'] };
    expect(classifyObserved([
      proc(10, 'my-agent.exe'), proc(11, 'node.exe', 'node C:/npm/@example/my-agent/bin.js'),
      proc(12, 'node.exe', 'node app.js --prompt @example/my-agent'), proc(13, 'powershell.exe', 'my-agent'),
    ], [rule]).map(agent => agent.pid)).toEqual([10, 11]);
  });
});
