// Prepare a fresh GitHub source tree without rewriting the user's existing history.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: applicationRoot, encoding: 'utf8' }).trim();
execFileSync(process.execPath, [join(applicationRoot, 'scripts', 'check-publication.mjs')], { cwd: applicationRoot, stdio: 'inherit' });
const exportRoot = join(repositoryRoot, '.waystation-export', `source-${randomUUID()}`);
const source = join(exportRoot, 'Waystation');
if (!resolve(source).startsWith(resolve(repositoryRoot) + sep)) throw new Error('Export target must stay inside the workspace.');
mkdirSync(source, { recursive: true });
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repositoryRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
let copied = 0;
for (const file of new Set(files)) {
  const normalized = file.replaceAll('\\', '/');
  if (/(?:^|\/)(?:\.git|\.playwright-mcp|\.desktop-verification|\.impeccable|\.waystation-export|node_modules|coverage|dist)(?:\/|$)/.test(normalized)) continue;
  const from = join(repositoryRoot, file);
  let stat;
  try { stat = statSync(from); } catch { continue; }
  if (!stat.isFile()) continue;
  const to = resolve(source, file);
  if (!to.startsWith(resolve(source) + sep)) throw new Error('Refusing a path outside the source export.');
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied += 1;
}
if (process.platform === 'win32') {
  const archive = join(exportRoot, 'Waystation-source.zip');
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${literal(source)} -DestinationPath ${literal(archive)} -CompressionLevel Optimal -ErrorAction Stop`], { windowsHide: true, stdio: 'inherit' });
}
console.log(`Prepared ${copied} source files in ${relative(repositoryRoot, source)}.`);
console.log('The export has no Git history, runtime state, installed dependencies, or local browser captures. The project license remains undecided.');
