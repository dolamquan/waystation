import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { DAEMON_HOST, DAEMON_PORT, paths } from './config.ts';
import { Tower } from './tower.ts';
import { startServer } from './api/server.ts';
import { DEV_WEB_PORT } from './api/security.ts';
import { acquireInstance, pidIsAlive } from './runtime/instance.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

// One bad request or agent must never take the tower (and every managed agent) down.
process.on('unhandledRejection', (reason) => console.error('[tower] unhandled rejection:', reason));
process.on('uncaughtException', (error) => console.error('[tower] uncaught exception:', error));

async function main(): Promise<void> {
  mkdirSync(paths.towerHome, { recursive: true });
  const releaseInstance = acquireInstance(join(paths.towerHome, 'daemon.lock'));
  let tower: Tower | undefined;
  let server: Server | undefined;
  let published = false;
  let shuttingDown = false;
  const startedAt = Date.now();
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (published) rmSync(paths.daemonInfo, { force: true });
      tower?.releaseAllIntercepts();
      server?.close();
      await tower?.shutdown();
    } finally {
      releaseInstance();
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Signals terminate Windows children immediately. The desktop uses its private
  // parent/child IPC channel so approvals and managed agents are cleaned up first.
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'waystation:shutdown') void shutdown();
  });
  process.on('disconnect', () => void shutdown());
  if (typeof process.send === 'function' && !process.connected) { await shutdown(); return; }
  try {
    // Older versions have no lock: also check their readiness file before SQLite.
    let oldPid: unknown;
    try { oldPid = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')).pid; } catch { /* absent/stale */ }
    if (typeof oldPid === 'number' && oldPid !== process.pid && pidIsAlive(oldPid)) {
      throw new Error('Waystation is already running. Open it, or stop that daemon before starting a new one.');
    }
    const token = randomBytes(24).toString('hex');
    tower = new Tower();
    await tower.start();
    if (shuttingDown) return;
    server = await startServer({ tower, port: DAEMON_PORT, host: DAEMON_HOST, token, webDist: join(projectRoot, 'web', 'dist'), dev, instance: { pid: process.pid, startedAt } });
    writeFileSync(paths.daemonInfo, JSON.stringify({ port: DAEMON_PORT, token, pid: process.pid, startedAt, dev }), { mode: 0o600 });
    published = true;
    const uiPort = dev ? DEV_WEB_PORT : DAEMON_PORT;
    console.log(`Waystation is running. Open: http://127.0.0.1:${uiPort}/#token=${token}`);
    console.log('(or run `npm run open`)');
  } catch (error) {
    console.error('Failed to start Waystation:', error instanceof Error ? error.message : 'unknown error');
    await shutdown(1);
  }
}

main().catch((error) => {
  console.error('Failed to start Waystation:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
