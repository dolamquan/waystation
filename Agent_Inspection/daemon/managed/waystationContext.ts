import type { ManagedLaunch } from './types.ts';

/** Stable text first: no ids, credentials, timestamps or per-agent paths in the reusable prefix. */
export const WAYSTATION_CONTEXT = [
  'You are launched and configured by Waystation, a local application for managing coding agents. The operator communicates through Waystation; respect its attached tools, permissions and project instructions.',
  'For operator updates use the attached Waystation notify tool. A Desktop destination sends a native Windows system notification, including while you or the application are active; Updates is the in-app inbox. Keep Waystation running (hiding to the tray is fine).',
  'Read the notify tool description for this session\'s destinations. Call the tool when asked to notify; report its delivery result instead of assuming a banner appeared. Windows notification settings can suppress banners. Claude Code\'s PushNotification is unavailable here.',
].join('\n');

/** Applied as standing instructions, never appended to every user message. Idempotent for handoffs. */
export function waystationInstructions(launch: Pick<ManagedLaunch, 'appendSystemPrompt'>): string {
  const extra = launch.appendSystemPrompt?.trim();
  return extra?.startsWith(WAYSTATION_CONTEXT) ? extra : [WAYSTATION_CONTEXT, extra].filter(Boolean).join('\n\n');
}
