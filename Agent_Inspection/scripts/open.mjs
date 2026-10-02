// Opens the tower UI with the session token (read from the per-user daemon.json).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.AGENT_TOWER_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'agent-tower');
let info;
try {
  info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
} catch {
  console.error('The tower is not running. Start it with `npm start` (or `npm run daemon`).');
  process.exit(1);
}
const port = info.dev ? 5173 : info.port;
const url = `http://127.0.0.1:${port}/#token=${info.token}`;
console.log(`Opening ${url.replace(info.token, '<token>')}`);
execFile('rundll32', ['url.dll,FileProtocolHandler', url], (error) => {
  if (error) console.error(`Could not open a browser automatically. Visit: ${url}`);
});
