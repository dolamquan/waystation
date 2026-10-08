import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_HOST, DAEMON_PORT, paths } from './config.ts';
import { Tower } from './tower.ts';
import { startServer } from './api/server.ts';
import { DEV_WEB_PORT } from './api/security.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

// One bad request or agent must never take the tower (and every managed agent) down.
process.on('unhandledRejection', (reason) => console.error('[tower] unhandled rejection:', reason));
process.on('uncaughtException', (error) => console.error('[tower] uncaught exception:', error));

async function main(): Promise<void> {
  mkdirSync(paths.towerHome, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const tower = new Tower();
  await tower.start();
  const server = await startServer({
    tower,
    port: DAEMON_PORT,
    host: DAEMON_HOST,
    token,
    webDist: join(projectRoot, 'web', 'dist'),
    dev,
  });
  // The hook script and `npm run open` read the port + token from here (per-user folder).
  writeFileSync(paths.daemonInfo, JSON.stringify({ port: DAEMON_PORT, token, pid: process.pid, startedAt: Date.now(), dev }));
  const uiPort = dev ? DEV_WEB_PORT : DAEMON_PORT;
  console.log(`Waystation is running. Open: http://127.0.0.1:${uiPort}/#token=${token}`);
  console.log('(or run `npm run open`)');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rmSync(paths.daemonInfo, { force: true });
    tower.releaseAllIntercepts();
    server.close();
    await tower.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('Failed to start Waystation:', error);
  process.exit(1);
});
