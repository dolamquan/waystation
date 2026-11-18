import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.WAYSTATION_HOSTED !== '1') throw new Error('Hosted workers require WAYSTATION_HOSTED=1.');
if (!process.env.AGENT_TOWER_HOME || !process.env.WAYSTATION_SECRETS_KEY_FILE || !process.env.WAYSTATION_WORKER_TOKEN_FILE || !process.env.WAYSTATION_PROJECT_ROOT) throw new Error('Configure the worker state, credential key, token and project root before starting.');
const token = readFileSync(process.env.WAYSTATION_WORKER_TOKEN_FILE, 'utf8').trim();
if (!/^[a-f0-9]{48,128}$/.test(token)) throw new Error('Worker token must be a random 24–64 byte hex value.');
mkdirSync(process.env.AGENT_TOWER_HOME, { recursive: true }); mkdirSync(process.env.WAYSTATION_PROJECT_ROOT, { recursive: true });
const { Tower } = await import('../tower.ts');
const { startServer } = await import('../api/server.ts');
const tower = new Tower();
const server = await startServer({ tower, port: Number(process.env.PORT ?? 4317), host: '0.0.0.0', token, webDist: resolve('web/dist') });
tower.library.agentPlatform.start();
console.log('Organization worker is ready.');
let stopping = false;
const shutdown = async () => { if (stopping) return; stopping = true; server.close(); await tower.shutdown(); process.exit(0); };
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
