import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopRuntime, probeDaemon, readDaemon, requestDaemon } from '../desktop/runtime.mjs';
import { tempDir } from './helpers.ts';

const runtimes: DesktopRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); });

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

async function makeRuntime() {
  const home = tempDir('desktop daemon with spaces-');
  const claudeHome = join(home, 'claude'); mkdirSync(claudeHome);
  const codexHome = join(home, 'codex'); mkdirSync(codexHome);
  const runtime = new DesktopRuntime({ projectRoot: resolve(__dirname, '..'), nodePath: process.execPath, home,
    env: { ...process.env, AGENT_TOWER_PORT: String(await freePort()), CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome, APPDATA: home },
  });
  runtimes.push(runtime);
  return runtime;
}

describe('real desktop daemon lifecycle', () => {
  it('authenticates readiness, reuses the daemon without taking ownership, and releases flags on IPC shutdown', async () => {
    const owner = await makeRuntime();
    const info = await owner.start();
    expect(await probeDaemon(info)).toBe(true);
    expect(owner.owned).toBe(true);
    const guest = new DesktopRuntime({ projectRoot: owner.projectRoot, nodePath: process.execPath, home: owner.home, env: owner.env });
    runtimes.push(guest);
    expect((await guest.start()).pid).toBe(info.pid);
    expect(guest.owned).toBe(false);
    await guest.stop();
    expect(await probeDaemon(info)).toBe(true);
    const flag = join(owner.home, 'intercept', '11111111-2222-3333-4444-555555555555');
    mkdirSync(join(owner.home, 'intercept')); writeFileSync(flag, '1');
    expect((await requestDaemon(info, '/api/state')).agents).toBeDefined();
    await owner.stop();
    expect(existsSync(flag)).toBe(false);
    expect(existsSync(join(owner.home, 'daemon.lock'))).toBe(false);
    expect(readDaemon(owner.home)).toBeUndefined();
    expect(await probeDaemon(info)).toBe(false);
  }, 45000);

  it('shuts down after its desktop parent disconnects', async () => {
    const owner = await makeRuntime();
    await owner.start();
    const child = owner.child!;
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.disconnect();
    await closed;
    expect(readDaemon(owner.home)).toBeUndefined();
    expect(existsSync(join(owner.home, 'daemon.lock'))).toBe(false);
  }, 45000);
});
