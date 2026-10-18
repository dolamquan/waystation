import { useCallback, useEffect, useState } from 'react';
import { api, type Prerequisite } from '../api.ts';
import { desktop, type DesktopPath, type DesktopSettings } from '../desktop.ts';
import { Icon } from './Icon.tsx';
import '../desktop.css';

const PATH_FIELDS: readonly { key: DesktopPath; label: string; hint: string }[] = [
  { key: 'claudeHome', label: 'Claude session folder', hint: 'Usually the .claude folder in your user directory.' },
  { key: 'codexHome', label: 'Codex session folder', hint: 'Usually the .codex folder in your user directory.' },
  { key: 'claudeExe', label: 'Claude Code executable', hint: 'Choose the native claude.exe file, rather than an npm .cmd shortcut.' },
  { key: 'codexJs', label: 'Codex CLI entry', hint: 'For a custom npm install, choose @openai/codex/bin/codex.js.' },
];
const CHECK_PURPOSE: Record<string, string> = {
  node: 'Runs Waystation. Needs Node.js 22.20 or newer.',
  git: 'Gives each team member a separate worktree and branch.',
  claude: 'Opens your Claude Code conversations in a terminal.',
  codex: 'Runs Codex agents and team members. Install with: npm install -g @openai/codex.',
  terminal: 'Opens real agent sessions in terminal tabs.',
  hooks: 'Lets you review tool calls and send messages to existing Claude Code sessions.',
};

export function DesktopSetup({ onDone }: { readonly onDone: () => void }) {
  const [settings, setSettings] = useState<DesktopSettings>();
  const [checks, setChecks] = useState<readonly Prerequisite[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [originalPaths, setOriginalPaths] = useState<Partial<Record<DesktopPath, string>>>({});
  const bridge = desktop();

  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const [preferences, result] = await Promise.all([desktop()!.getSettings(), api.prerequisites()]);
      setSettings((current) => current ? { ...preferences, paths: current.paths, notifications: current.notifications } : preferences);
      setOriginalPaths(preferences.paths); setChecks(result.prerequisites);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (useDefaults = false) => {
    if (!settings || !bridge) return;
    setSaving(true); setError(undefined); setFeedback(undefined);
    try {
      await bridge.saveSettings({ setupComplete: true, notifications: settings.notifications, paths: useDefaults ? (await bridge.getSettings()).paths : settings.paths });
      onDone();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };

  const browse = async (key: DesktopPath) => {
    if (!bridge || !settings) return;
    try {
      const path = await bridge.choosePath(key);
      if (path) setSettings((current) => current ? { ...current, paths: { ...current.paths, [key]: path } } : current);
    } catch (err) { setError((err as Error).message); }
  };

  const installHooks = async () => {
    setSaving(true); setError(undefined);
    try {
      await api.installHooks();
      setFeedback('Hooks connected. New Claude Code sessions can now send tool decisions to the station. Restart older sessions to connect them.');
      const result = await api.prerequisites(); setChecks(result.prerequisites);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };

  const pathsChanged = settings && PATH_FIELDS.some(({ key }) => settings.paths[key] !== originalPaths[key]);
  return <section className="desktop-setup" aria-label="Desktop setup" aria-busy={loading || saving}>
    <p className="desktop-intro">Waystation uses your own agent installations and accounts. Start a session in your usual terminal, then see it here. You can explore the station before connecting every tool.</p>
    {settings && <div className="desktop-entry"><button className="btn btn-go" disabled={loading || saving} onClick={() => void save(true)}>Explore with current settings<Icon name="arrow" size={16} /></button><span>You can return to setup anytime.</span></div>}
    {error && <div className="detail-load-error" role="alert"><p>{error}</p><button className="btn" onClick={() => void refresh()} disabled={loading || saving}>Retry setup checks</button></div>}
    {feedback && <p className="desktop-feedback" role="status">{feedback}</p>}
    <div className="desktop-section-heading"><h2>Tools on this machine</h2><button className="btn btn-ghost" disabled={loading || saving} onClick={() => void refresh()}><Icon name="refresh" size={16} />{loading ? 'Checking…' : 'Check again'}</button></div>
    {loading && checks.length === 0 && <p role="status">Checking your local tools…</p>}
    <ul className="desktop-checks">
      {checks.map((check) => <li key={check.id}>
        <Icon name={check.ok ? 'check' : 'info'} size={19} />
        <div><strong>{check.label}</strong><p>{CHECK_PURPOSE[check.id] ?? check.purpose}</p><small>{check.detail}</small>
          {check.id === 'claude' && <p>Sign in with <code>claude</code> in your terminal, or configure your own Anthropic API access.</p>}
          {check.id === 'codex' && <p>After installing, run <code>codex</code> in your terminal and sign in.</p>}
          {check.id === 'hooks' && !check.ok && <details><summary>Connect Claude Code hooks</summary><p>This adds Waystation entries to your Claude settings after making a backup. Existing hooks are preserved.</p><button className="btn" type="button" disabled={saving} onClick={() => void installHooks()}>Install hooks</button></details>}
        </div>
        <span className={`desktop-check-status ${check.ok ? 'ready' : ''}`}>{check.ok ? 'Ready' : check.id === 'node' ? 'Required' : 'Optional'}</span>
      </li>)}
    </ul>
    {settings && <>
      <details className="desktop-paths">
        <summary>Custom session and executable paths</summary>
        <p>Leave a field empty to use automatic detection or your environment settings. Saving changed paths restarts the local daemon; stop managed agents first.</p>
        {!settings.ownsDaemon && <p className="desktop-path-note">This daemon was started in a terminal. Stop it and reopen the desktop app before changing paths.</p>}
        <div className="desktop-path-list">
          {PATH_FIELDS.map(({ key, label, hint }) => <div className="form-field" key={key}>
            <label htmlFor={`desktop-${key}`}>{label}</label>
            <div className="desktop-path-field"><input id={`desktop-${key}`} className="text-input" value={settings.paths[key]} placeholder={settings.effectivePaths[key]} disabled={saving || !settings.ownsDaemon} onChange={(event) => setSettings({ ...settings, paths: { ...settings.paths, [key]: event.target.value } })} /><button className="btn" type="button" disabled={saving || !settings.ownsDaemon} onClick={() => void browse(key)} aria-label={`Choose ${label.toLowerCase()}`}><Icon name="folder" size={16} />Browse</button></div>
            <small>{hint}</small>
          </div>)}
        </div>
      </details>
      <div className="desktop-preferences">
        <label><input type="checkbox" checked={settings.notifications} disabled={saving} onChange={(event) => setSettings({ ...settings, notifications: event.target.checked })} />Notify me when agents need attention</label>
        {!settings.notificationsSupported && <p>Native notifications are unavailable on this machine. Decisions still appear in the station.</p>}
        <p>Closing the window keeps Waystation in the tray so agents and schedules can continue. Use <strong>Quit Waystation</strong> in the tray menu to stop the app.</p>
        <p>Your Waystation data lives in <code>{settings.home}</code>. Agent accounts and session folders are configured separately.</p>
      </div>
      <footer className="desktop-setup-actions"><button className="btn btn-go" disabled={loading || saving} onClick={() => void save()}>{saving ? 'Saving…' : pathsChanged ? 'Save paths & restart' : 'Save & open station'}<Icon name="arrow" size={16} /></button></footer>
    </>}
    {!settings && !loading && <button className="btn" onClick={onDone}>Open station</button>}
  </section>;
}
