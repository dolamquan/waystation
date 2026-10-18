const vscode = require('vscode');
const WebSocket = require('ws');
const { readFile, readdir } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { homedir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// Process command lines stay in memory and are never logged or sent to Waystation.
const PROCESS_SCRIPT = `@(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name;
    start=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() } else { '' });
    cmd=$(if ($_.Name -match '^(claude|node)(\\.exe)?$') { [string]$_.CommandLine } else { '' }) }
}) | ConvertTo-Json -Compress`;

async function processes() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SCRIPT], {
    windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  const rows = JSON.parse(stdout);
  return new Map((Array.isArray(rows) ? rows : [rows]).map(row => [row.pid, row]));
}

function sameStart(recorded, actual) {
  if (!/^\d{10,20}$/.test(recorded ?? '') || !/^\d{10,20}$/.test(actual ?? '')) return false;
  const delta = BigInt(recorded) - BigInt(actual);
  // CIM rounds Windows FILETIME to microseconds.
  return delta > -10000n && delta < 10000n;
}

function isClaude(proc) {
  return proc && (/^claude(?:\.exe)?$/i.test(proc.name)
    || /^node(?:\.exe)?$/i.test(proc.name) && /[\\/]@anthropic-ai[\\/]claude-code[\\/].*cli\.(?:m?js)/i.test(proc.cmd));
}

function descendsFrom(tree, pid, shellPid) {
  const visited = new Set();
  for (let depth = 0; depth < 32 && pid > 0 && !visited.has(pid); depth++) {
    if (pid === shellPid) return true;
    visited.add(pid);
    pid = tree.get(pid)?.ppid;
  }
  return false;
}

function validSession(record, tree) {
  return record && typeof record.sessionId === 'string' && record.sessionId.length <= 200
    && Number.isInteger(record.pid) && record.pid > 4 && record.kind === 'interactive' && record.entrypoint === 'cli'
    && isClaude(tree.get(record.pid)) && sameStart(record.procStart, tree.get(record.pid)?.start);
}

async function readSession(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Waystation Terminal Bridge');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.command = 'waystation.connectTerminals';
  status.tooltip = 'Waystation sends to idle Claude sessions in their original terminals. Keep terminal input empty.';
  context.subscriptions.push(output, status);
  let socket, identity, sessionsDir, stopped = false, ticking = false;
  let bindings = new Map();
  const submitting = new Set();
  const handled = new Set();
  const shellCommands = new Map();
  const recentlySubmitted = new Map();

  function label(text) { status.text = `$(plug) Waystation: ${text}`; status.show(); }
  function send(message, target = socket) {
    if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(message));
  }
  function disconnect() {
    const previous = socket;
    socket = undefined;
    identity = undefined;
    sessionsDir = undefined;
    bindings.clear();
    previous?.terminate();
  }

  async function discover() {
    if (!sessionsDir || socket?.readyState !== WebSocket.OPEN) return;
    const target = socket;
    const terminals = await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
    const live = terminals.filter(item => Number.isInteger(item.pid) && item.pid > 4 && !item.terminal.creationOptions.isTransient);
    if (!live.length) { bindings.clear(); send({ type: 'terminal:sessions', sessions: [] }, target); label('connected, no Claude terminals'); return; }
    const tree = await processes();
    const names = (await readdir(sessionsDir).catch(() => [])).filter(name => name.endsWith('.json'));
    const records = await Promise.all(names.map(async name => ({ file: join(sessionsDir, name), record: await readSession(join(sessionsDir, name)) })));
    const next = new Map();
    for (const { file, record } of records) {
      if (!validSession(record, tree)) continue;
      const matches = live.filter(item => descendsFrom(tree, record.pid, item.pid));
      if (matches.length !== 1) continue;
      const { terminal, pid: shellPid } = matches[0];
      const shell = tree.get(shellPid);
      if (!shell) continue;
      // Refuse ambiguous multiplexers or more than one Claude process under this shell.
      const claudes = [...tree.values()].filter(proc => isClaude(proc) && descendsFrom(tree, proc.pid, shellPid));
      if (claudes.length !== 1) continue;
      next.set(record.sessionId, { file, terminal, shellPid, shellStart: shell.start, pid: record.pid, procStart: record.procStart });
    }
    if (socket !== target || target.readyState !== WebSocket.OPEN) return;
    bindings = next;
    send({ type: 'terminal:sessions', sessions: [...next].map(([sessionId, binding]) => ({ sessionId, pid: binding.pid, procStart: binding.procStart })) }, target);
    label(next.size ? `${next.size} Claude terminal${next.size === 1 ? '' : 's'}` : 'connected, no Claude terminals');
  }

  async function submit(message, target) {
    if (handled.has(message.id)) return;
    handled.add(message.id);
    if (handled.size > 200) handled.delete(handled.values().next().value);
    let pasted = false;
    let ownsLock = false;
    try {
      if (!vscode.workspace.getConfiguration('waystation.terminalBridge').get('enabled', true)) throw new Error('The Waystation terminal bridge is disabled in VS Code.');
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 8000
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message.text)) {
        throw new Error('This message contains unsupported terminal control characters or exceeds the message limit.');
      }
      if (submitting.has(message.sessionId)) throw new Error('This terminal is already submitting a message.');
      const binding = bindings.get(message.sessionId);
      if (!binding || binding.pid !== message.pid || binding.procStart !== message.procStart
          || !vscode.window.terminals.includes(binding.terminal) || binding.terminal.exitStatus !== undefined) {
        throw new Error('The original Claude terminal closed or changed. Reconnect before sending.');
      }
      submitting.add(message.sessionId);
      ownsLock = true;
      const tree = await processes();
      const record = await readSession(binding.file);
      if (!validSession(record, tree) || record.sessionId !== message.sessionId || record.pid !== message.pid
          || record.procStart !== message.procStart || record.status !== 'idle'
          || !sameStart(binding.shellStart, tree.get(binding.shellPid)?.start)
          || !descendsFrom(tree, message.pid, binding.shellPid)
          || [...tree.values()].filter(proc => isClaude(proc) && descendsFrom(tree, proc.pid, binding.shellPid)).length !== 1) {
        throw new Error('Claude is no longer idle in the original terminal. Check its prompt and try again.');
      }
      const previous = recentlySubmitted.get(message.sessionId);
      if (previous && Date.now() - previous.at < 2000) throw new Error('Wait a moment for the previous message to start in Claude.');
      if (shellCommands.has(binding.terminal) && shellCommands.get(binding.terminal) === null) {
        throw new Error('Claude returned to the shell prompt. The message was not submitted.');
      }
      if (socket !== target || target.readyState !== WebSocket.OPEN || !vscode.window.terminals.includes(binding.terminal)) {
        throw new Error('The VS Code connection changed before submission.');
      }
      if (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt) throw new Error('The request expired before submission. The message was not sent.');
      try { process.kill(message.pid, 0); } catch { throw new Error('Claude exited before submission. The message was not sent.'); }
      // Paste is one literal input block; newline characters cannot submit separate commands.
      // Never clear existing terminal input, switch focus, interrupt, restart, or fork Claude.
      const text = message.text.replace(/\r\n?/g, '\n');
      binding.terminal.sendText(`\x1b[200~${text}\x1b[201~`, false);
      pasted = true;
      binding.terminal.sendText('\r', false);
      recentlySubmitted.set(message.sessionId, { at: Date.now() });
      send({ type: 'terminal:ack', id: message.id, ok: true }, target);
    } catch (error) {
      send({ type: 'terminal:ack', id: message.id, ok: false,
        error: pasted ? 'The message may be in the original terminal input. Check it before sending again.' : error.message }, target);
    } finally { if (ownsLock) submitting.delete(message.sessionId); }
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const config = vscode.workspace.getConfiguration('waystation.terminalBridge');
      if (!config.get('enabled', true)) { disconnect(); label('disabled'); return; }
      if (process.platform !== 'win32' || vscode.env.remoteName) { disconnect(); label('local Windows terminals only'); return; }
      const data = config.get('dataDirectory', '').trim() || process.env.AGENT_TOWER_HOME
        || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agent-tower');
      const info = JSON.parse(await readFile(join(data, 'daemon.json'), 'utf8'));
      if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{32,}$/i.test(info.token ?? '')) throw new Error('Invalid daemon information.');
      const nextIdentity = `${info.pid}:${info.startedAt}:${info.port}:${info.token}`;
      if (identity !== nextIdentity || !socket || socket.readyState === WebSocket.CLOSED) {
        disconnect();
        identity = nextIdentity;
        const target = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, ['agent-tower', info.token], { handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024 });
        socket = target;
        target.on('open', () => { label('connecting terminals'); send({ type: 'terminal:register', version: 1 }, target); });
        target.on('message', raw => {
          if (socket !== target) return;
          let message;
          try { message = JSON.parse(String(raw)); } catch { return; }
          if (message?.type === 'terminal:config' && message.version === 1 && typeof message.sessionsDir === 'string' && isAbsolute(message.sessionsDir)) {
            sessionsDir = message.sessionsDir;
            void tick();
          } else if (message?.type === 'terminal:send' && typeof message.id === 'string') {
            void submit(message, target);
          }
        });
        target.on('error', () => { if (socket === target) { disconnect(); label('waiting for Waystation'); } });
        target.on('close', () => { if (socket === target) { disconnect(); label('waiting for Waystation'); } });
        label('connecting');
      }
      await discover();
    } catch {
      // Tokens and daemon response bodies must not reach extension output.
      disconnect();
      label('waiting for Waystation');
    } finally { ticking = false; }
  }

  // Shell integration can veto input after the foreground command ends. It is not required for discovery.
  context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(event => {
    shellCommands.set(event.terminal, event.execution);
  }), vscode.window.onDidEndTerminalShellExecution(event => {
    if (!shellCommands.has(event.terminal) || shellCommands.get(event.terminal) === event.execution) shellCommands.set(event.terminal, null);
  }), vscode.window.onDidCloseTerminal(terminal => {
    shellCommands.delete(terminal);
    for (const [sessionId, binding] of bindings) if (binding.terminal === terminal) bindings.delete(sessionId);
    send({ type: 'terminal:sessions', sessions: [...bindings].map(([sessionId, binding]) => ({ sessionId, pid: binding.pid, procStart: binding.procStart })) });
  }), vscode.commands.registerCommand('waystation.connectTerminals', async () => {
    await tick();
    output.appendLine(status.text.replace('$(plug) ', ''));
    if (!sessionsDir) output.appendLine('Start or restart Waystation to load its terminal bridge. Custom data folders can be set in Waystation settings.');
    output.show(true);
  }));
  const timer = setInterval(() => void tick(), 4000);
  context.subscriptions.push({ dispose() { stopped = true; clearInterval(timer); disconnect(); } });
  void tick();
}

module.exports = { activate };
