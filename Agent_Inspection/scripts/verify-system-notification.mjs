// Opt-in native Windows check. Sends one actual system alert; no daemon or paid agent is launched.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(script), '..');
if (!process.versions.electron) {
  const electronPath = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [script], { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, Notification, shell } = await import('electron');
  const { DESKTOP_APP_ID, DesktopNotifications, registerNotificationShortcut } = await import('../desktop/notifications.mjs');
  app.setName('Waystation');
  app.setAppUserModelId(DESKTOP_APP_ID);
  app.on('window-all-closed', () => {});
  const timeout = setTimeout(() => { console.error('Native notification check timed out.'); app.exit(1); }, 15000);
  // Do not await readiness at module scope: Electron finishes loading the ESM entry before ready.
  app.whenReady().then(async () => { try {
    registerNotificationShortcut({ app, shell, projectRoot });
    const alerts = new DesktopNotifications({ Notification, icon: () => undefined, onClick: () => {} });
    await alerts.show({ title: 'Waystation notification check', body: 'Native Windows system alerts are connected. This check did not start a coding agent.' });
    console.log(JSON.stringify({ ok: true, appId: DESKTOP_APP_ID, transport: 'Electron native Windows notification', acknowledgment: 'OS accepted; banner visibility follows Windows settings' }));
    // Keep the sender alive briefly so Windows can present the banner.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    clearTimeout(timeout);
    app.exit(1);
  } });
}
