import { LibraryInputError } from '../../library/types.ts';
import { clip } from './http.ts';
import type { ChannelSpec } from './types.ts';

export const TOAST_TITLE_ENV = 'WAYSTATION_TOAST_TITLE';
export const TOAST_BODY_ENV = 'WAYSTATION_TOAST_BODY';

/**
 * Windows toast through Windows PowerShell's own registered app id. The text arrives in
 * environment variables and becomes XML text nodes, so nothing the agent wrote is ever parsed
 * as script or markup.
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$texts = $xml.GetElementsByTagName('text')",
  `[void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:${TOAST_TITLE_ENV}))`,
  `[void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:${TOAST_BODY_ENV}))`,
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
].join('\n');

/** `-EncodedCommand` takes base64 of UTF-16LE, which sidesteps every quoting rule. */
export const encodedToastScript = (): string => Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');

export const desktop: ChannelSpec = {
  kind: 'desktop',
  configKeys: [],
  requiredConfig: [],
  secretNames: [],
  requiredSecrets: [],
  validate: () => {
    if (process.platform !== 'win32') throw new LibraryInputError('Desktop notifications are only available on Windows');
  },
  deliver: (ctx) => ctx.io.showToast(clip(ctx.message.title, 120), clip(ctx.message.body, 400), ctx.signal),
};
