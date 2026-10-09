#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportsNode } from '../desktop/runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.error('Waystation desktop currently supports Windows. See docs/desktop.md.');
  process.exit(1);
}
if (!supportsNode(process.version)) {
  console.error('Waystation requires Node.js 22.20 or newer. Update Node, then run npm run desktop.');
  process.exit(1);
}
let executable;
try { executable = createRequire(import.meta.url)('electron'); }
catch {
  console.error('Electron is not installed. Run npm ci (including dev dependencies), then npm run desktop.');
  process.exit(1);
}
const env = { ...process.env, WAYSTATION_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
child.on('error', (error) => { console.error(`Could not open Waystation: ${error.message}`); process.exitCode = 1; });
child.on('close', (code) => {
  process.exitCode = code ?? 1;
  if (process.connected) process.disconnect();
});
// Ctrl+C asks the desktop to quit gracefully. Forced process-tree termination
// can skip cleanup; the next launch recovers locks belonging to dead processes.
const requestQuit = () => {
  if (child.connected) child.send({ type: 'waystation:quit' }, () => {});
};
process.on('SIGINT', requestQuit);
process.on('SIGTERM', requestQuit);
// A private parent/child channel lets automation exercise the same quit handler.
process.on('message', (message) => { if (message?.type === 'waystation:quit') requestQuit(); });
if (process.connected) process.on('disconnect', requestQuit);
