// Read-only review of source and reachable Git blobs. Never print matched values.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
const findings = new Map();
let files = 0, historicalBlobs = 0;
const ownProfile = (process.env.USERPROFILE ?? '').toLowerCase();
const patterns = [
  ['provider credential', /\b(?:sk-ant-[A-Za-z0-9_-]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{24,}|AIzaSy[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const textFile = (file) => /\.(?:[cm]?js|tsx?|json|md|css|html|ya?ml|toml|txt|ini|cfg|ps1|sh)$/i.test(file) || /^\.(?:env(?:\..+)?|npmrc|gitignore)$/.test(basename(file));
const sensitiveFile = (file) => /(?:^|\/)(?:daemon\.json|daemon\.lock|secrets\.json|desktop\.json|\.env(?:\.(?!example$).+)?)$|\.(?:db(?:-shm|-wal)?|sqlite|pem|key|pfx|log)$/i.test(file);

function flag(source, file, kind, line = 0) {
  findings.set(`${source}:${file}:${kind}:${line}`, { source, file, kind, line });
}

function scan(data, file, source) {
  if (sensitiveFile(file)) flag(source, file, 'runtime/credential file');
  if (!textFile(file) || data.length > 2 * 1024 * 1024 || data.subarray(0, 8192).includes(0)) return;
  const text = data.toString('utf8');
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // Explicit, repeated-character credentials in redaction tests are synthetic.
      if (/\/tests\//.test(`/${file}`) && /([A-Za-z0-9])\1{15,}/.test(match[0])) continue;
      flag(source, file, kind, text.slice(0, match.index).split('\n').length);
    }
  }
  const normalized = text.toLowerCase().replace(/\\{2,}/g, '\\').replaceAll('/', '\\');
  if (ownProfile && normalized.includes(ownProfile)) flag(source, file, 'current user absolute path');
}

const names = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
for (const file of new Set(names)) {
  const path = join(root, file);
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  files += 1;
  scan(readFileSync(path), file, 'working tree');
}

if (process.argv.includes('--history')) {
  const objects = git(['rev-list', '--objects', '--all']).trim().split('\n').flatMap((line) => {
    const space = line.indexOf(' ');
    if (space < 0) return [];
    const file = line.slice(space + 1);
    return textFile(file) || sensitiveFile(file) ? [{ hash: line.slice(0, space), file }] : [];
  });
  if (objects.length) {
    const output = git(['cat-file', '--batch'], { input: Buffer.from(objects.map((item) => item.hash).join('\n') + '\n'), encoding: null });
    let offset = 0;
    for (const object of objects) {
      const newline = output.indexOf(10, offset);
      const [hash, type, rawSize] = output.subarray(offset, newline).toString('utf8').split(' ');
      const size = Number(rawSize);
      if (!Number.isInteger(size)) throw new Error('Could not read a historical object.');
      offset = newline + 1;
      if (type === 'blob') { historicalBlobs += 1; scan(output.subarray(offset, offset + size), object.file, `Git blob ${hash.slice(0, 12)}`); }
      offset += size + 1;
    }
  }
}

console.log(`Reviewed ${files} working-tree files and ${historicalBlobs} reachable historical blobs.`);
for (const finding of findings.values()) console.log(`REVIEW ${finding.source}: ${finding.file}${finding.line ? `:${finding.line}` : ''} (${finding.kind}; value withheld)`);
if (findings.size) {
  console.log(`${findings.size} finding(s) need review. The script does not edit files or Git history.`);
  process.exitCode = 1;
} else console.log('No configured credential, runtime-file, or current-user-path patterns found. This pattern review does not certify the absence of every secret.');
