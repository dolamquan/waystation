// Package the local companion using the existing ws dependency. No Marketplace upload or extra install is needed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('The Waystation terminal bridge currently supports local Windows VS Code terminals.');
const source = join(root, 'integrations', 'vscode');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const output = join(root, '.vscode-bridge');
const stage = join(output, `package-${randomUUID()}`);
const extension = join(stage, 'extension');
mkdirSync(extension, { recursive: true });
for (const file of ['package.json', 'extension.cjs', 'README.md']) copyFileSync(join(source, file), join(extension, file));
const wsRoot = dirname(createRequire(import.meta.url).resolve('ws/package.json'));
const wsTarget = join(extension, 'node_modules', 'ws');
mkdirSync(wsTarget, { recursive: true });
for (const file of ['package.json', 'index.js', 'wrapper.mjs', 'browser.js', 'LICENSE']) copyFileSync(join(wsRoot, file), join(wsTarget, file));
mkdirSync(join(wsTarget, 'lib'));
for (const file of readdirSync(join(wsRoot, 'lib'))) copyFileSync(join(wsRoot, 'lib', file), join(wsTarget, 'lib', file));
writeFileSync(join(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`);
writeFileSync(join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
<Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/><DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Tags>waystation,claude,terminal</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`);

const archive = join(output, `${manifest.name}-${manifest.version}-${Date.now()}.vsix`);
const literal = value => `'${value.replaceAll("'", "''")}'`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${literal(stage)}, ${literal(archive)})`], { windowsHide: true, stdio: 'inherit' });
console.log(`Packaged ${archive}`);
if (!process.argv.includes('--install')) {
  console.log('Run npm run vscode:install to install it into VS Code.');
  process.exit(0);
}

const candidates = [process.env.WAYSTATION_VSCODE_EXE,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe')];
try {
  const commands = execFileSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  for (const command of commands) candidates.push(join(dirname(command), '..', 'Code.exe'));
} catch { /* A standard installation can still be found without PATH. */ }
function cliFor(executable) {
  if (!executable || !existsSync(executable)) return undefined;
  const base = dirname(executable);
  // Recent VS Code installs keep resources in a versioned directory; follow their launcher.
  try {
    const launcher = readFileSync(join(base, 'bin', 'code.cmd'), 'utf8');
    const match = /"%~dp0\.\.[\\/]([^"\r\n]*resources[\\/]app[\\/]out[\\/]cli\.js)"/i.exec(launcher);
    const path = match && resolve(base, match[1]);
    if (path && existsSync(path)) return path;
  } catch { /* Older layouts use the direct path below. */ }
  const direct = join(base, 'resources', 'app', 'out', 'cli.js');
  return existsSync(direct) ? direct : undefined;
}
const editor = candidates.map(executable => ({ executable, cli: cliFor(executable) })).find(candidate => candidate.cli);
if (!editor) {
  console.error('VS Code was not found. Use Extensions → Install from VSIX with the file above, or set WAYSTATION_VSCODE_EXE to Code.exe and run this command again.');
  process.exitCode = 1;
} else {
  // Use the editor's CLI directly, avoiding shell interpretation of repository paths.
  execFileSync(editor.executable, [editor.cli, '--install-extension', archive, '--force'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit', timeout: 60_000,
  });
  console.log('In the existing VS Code window, run “Waystation: Connect terminal sessions” from the Command Palette.');
  console.log('Restart Waystation to load the daemon change. Leave the original Claude terminal running with an empty input prompt.');
}
