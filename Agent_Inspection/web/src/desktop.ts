export type DesktopPath = 'claudeHome' | 'codexHome' | 'claudeExe' | 'codexJs';
export interface DesktopPreferences {
  readonly setupComplete: boolean;
  readonly notifications: boolean;
  readonly paths: Record<DesktopPath, string>;
}
export interface DesktopSettings extends DesktopPreferences {
  readonly home: string;
  readonly effectivePaths: Record<DesktopPath, string>;
  readonly nodeVersion: string;
  readonly ownsDaemon: boolean;
  readonly version: string;
  readonly notificationsSupported: boolean;
}
export interface DesktopBridge {
  getSettings(): Promise<DesktopSettings>;
  saveSettings(preferences: DesktopPreferences): Promise<DesktopSettings>;
  choosePath(kind: DesktopPath | 'project'): Promise<string | undefined>;
  onNavigate(listener: (destination: 'setup' | 'attention') => void): () => void;
}

declare global {
  interface Window { waystationDesktop?: DesktopBridge }
}

export const desktop = (): DesktopBridge | undefined => typeof window === 'undefined' ? undefined : window.waystationDesktop;
