import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DESKTOP_APP_ID = 'Waystation.Desktop';

/** Source releases need the same Windows notification identity as an installed desktop app. */
export function registerNotificationShortcut({ app, shell, projectRoot, appData = process.env.APPDATA }) {
  if (process.platform !== 'win32') return;
  if (!appData) throw new Error('Windows AppData is unavailable for notification registration.');
  const folder = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  mkdirSync(folder, { recursive: true });
  const shortcut = join(folder, 'Waystation.lnk');
  const options = {
    target: process.execPath,
    cwd: projectRoot,
    // The source folder is the Electron entry. Escape Windows command-line quotes and trailing slashes.
    args: app.isPackaged ? '' : `"${projectRoot.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`,
    description: 'Waystation coding agent workspace',
    appUserModelId: DESKTOP_APP_ID,
  };
  if (!shell.writeShortcutLink(shortcut, 'create', options)) throw new Error('Could not register Waystation with Windows notifications.');
}

/** Retain native objects until closed and acknowledge OS submission, never promise a visible banner. */
export class DesktopNotifications {
  active = new Set();

  constructor({ Notification, icon, onClick, timeoutMs = 5000 }) {
    this.Notification = Notification;
    this.icon = icon;
    this.onClick = onClick;
    this.timeoutMs = timeoutMs;
  }

  show({ title, body }) {
    if (!this.Notification.isSupported()) return Promise.reject(new Error('System notifications are unavailable on this machine.'));
    return new Promise((resolve, reject) => {
      const notification = new this.Notification({ title: String(title).slice(0, 120), body: String(body ?? '').slice(0, 400), icon: this.icon() });
      this.active.add(notification);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { clearTimeout(release); this.active.delete(notification); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Windows did not acknowledge the system notification. Check Windows notification settings.')), this.timeoutMs);
      notification.once('show', () => finish());
      notification.once('failed', (_event, reason) => finish(new Error(`Windows notification failed: ${String(reason || 'unknown error').slice(0, 200)}`)));
      notification.once('close', () => { clearTimeout(release); this.active.delete(notification); if (!settled) finish(new Error('System notification closed before delivery.')); });
      notification.on('click', () => this.onClick());
      // Keep cleanup bounded even if Windows never emits close (notification center retention).
      const release = setTimeout(() => this.active.delete(notification), 10 * 60_000);
      release.unref?.();
      try { notification.show(); } catch (error) { finish(error); }
    });
  }
}
