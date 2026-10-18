import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { integrationsApi, type AvailablePlugin, type CodexPluginView } from '../../library/integrationsApi.ts';
import { Icon } from '../Icon.tsx';
import type { SectionProps } from './IntegrationsPanel.tsx';
import { MarketplaceDialog, useMarketplace } from './PluginMarketplace.tsx';

const errorText = (err: unknown) => (err as Error).message;

/** Codex's own plugins (`codex plugin add/remove`). Codex loads every enabled one in each session. */
export function CodexPluginsSection({ notify, ask }: SectionProps) {
  const [plugins, setPlugins] = useState<readonly CodexPluginView[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [output, setOutput] = useState<string>();
  const marketplace = useMarketplace(integrationsApi.availableCodexPlugins);

  const load = useCallback(async () => {
    try {
      setPlugins((await integrationsApi.codexPlugins()).plugins);
      setError(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Runs a `codex plugin` action, which can take a while; shows what the CLI printed. */
  const runCli = async (id: string, fn: () => Promise<{ output: string }>, ok: string) => {
    setBusy(id);
    try {
      const result = await fn();
      setOutput(result.output || undefined);
      notify(ok);
      await load();
      await marketplace.refresh();
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setBusy(undefined);
    }
  };

  const install = (p: AvailablePlugin) => ask({
    title: `Install ${p.name}?`,
    body: `Runs “codex plugin add ${p.id}”. Plugins run code and can connect to your accounts: install only ones you trust.`,
    label: 'Install',
    action: () => runCli(p.id, () => integrationsApi.installCodexPlugin(p.id), `${p.name} installed`),
  });

  const uninstall = (p: CodexPluginView) => ask({
    title: `Uninstall ${p.name}?`,
    body: 'It is removed from Codex for every session, not just Waystation agents.',
    label: 'Uninstall',
    action: () => runCli(p.id, () => integrationsApi.uninstallCodexPlugin(p.id), `${p.name} uninstalled`),
  });

  return (
    <section className="ops-section" aria-labelledby="int-codex-plugins">
      <div className="section-heading">
        <div><h2 id="int-codex-plugins">Codex plugins</h2><p>Installed with Codex’s own plugin manager. Enabled plugins load in every Codex agent and Codex session; Claude agents ignore them.</p></div>
        <button className="btn" onClick={marketplace.show} aria-haspopup="dialog"><Icon name="search" size={15} />Browse marketplaces</button>
      </div>
      {error && <div className="detail-load-error" role="alert"><p>Couldn’t load Codex plugins. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
      {output && <pre className="int-output" aria-label="Output from codex plugin">{output}</pre>}
      {loading && <p className="workspace-loading" role="status">Loading Codex plugins…</p>}
      {!loading && plugins.length === 0 && !error && <p className="detail-empty-text">No Codex plugins installed. Browse the marketplaces to install one.</p>}
      <ul className="ops-list" aria-label="Installed Codex plugins">
        {plugins.map((p) => (
          <li key={p.id} className="ops-row">
            <div className="ops-row-main">
              <strong>{p.name} <span className="int-tag">{p.marketplace}{p.version ? ` · ${p.version}` : ''}</span></strong>
              {p.description && <small>{p.description}</small>}
              <small>{p.enabled ? 'Enabled' : 'Disabled'} in Codex{p.source ? ` · ${p.source}` : ''}</small>
            </div>
            <div className="ops-row-actions">
              <button className="btn btn-small btn-danger" disabled={busy === p.id} onClick={() => uninstall(p)}>
                {busy === p.id ? 'Working…' : 'Uninstall'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <AnimatePresence>
        {marketplace.open && (
          <MarketplaceDialog title="Codex plugin marketplaces" marketplace={marketplace} busy={busy} output={output}
            emptyHint="No marketplaces found. Add one with “codex plugin marketplace add”, or sign in to Codex for the OpenAI catalog."
            onInstall={install} />
        )}
      </AnimatePresence>
    </section>
  );
}
