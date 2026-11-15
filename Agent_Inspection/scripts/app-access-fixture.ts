/** Isolated browser verification. Provider HTTP calls are simulated; broker/auth/graph/MCP paths are real. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.AGENT_TOWER_HOME = mkdtempSync(join(tmpdir(), 'app-access-browser-'));
process.env.CLAUDE_HOME = join(process.env.AGENT_TOWER_HOME, 'claude');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith('https://discord.com/') ? Response.json({ id: 'simulated-message', content: 'Simulated provider result' }) : realFetch(url, init);
const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
const tower = new Tower(':memory:'); const port = 47379; const token = 'a0c417ec70e0123456789abcdef0123456789abcdef';
const project = mkdtempSync(join(tmpdir(), 'app-access-project-'));
const doc = tower.library.automation.architectures.create({ project, graph: 'starter' }).document;
const server = await startServer({ tower, host: '127.0.0.1', port, token, webDist: resolve('.impeccable/app-access/build') });
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, token, project, architectureId: doc.id }));
process.on('SIGTERM', () => { server.close(); void tower.shutdown().finally(() => process.exit(0)); });
