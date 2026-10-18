import { useCallback, useState } from 'react';
import type { AvailablePlugin } from '../../library/integrationsApi.ts';
import { Modal } from '../Modal.tsx';

const errorText = (err: unknown) => (err as Error).message;

export interface Marketplace {
  /** True while the browser dialog is open. */
  readonly open: boolean;
  /** Undefined while the first load is in flight. */
  readonly plugins?: readonly AvailablePlugin[];
  readonly error?: string;
  readonly show: () => void;
  readonly close: () => void;
  /** Reloads the list if the dialog is open (e.g. after an install). */
  readonly refresh: () => Promise<void>;
}

/** Open/close state and data for a plugin marketplace browser. */
export function useMarketplace(load: () => Promise<{ plugins: AvailablePlugin[] }>): Marketplace {
  const [open, setOpen] = useState(false);
  const [plugins, setPlugins] = useState<readonly AvailablePlugin[]>();
  const [error, setError] = useState<string>();

  const fetchPlugins = useCallback(async () => {
    try {
      setPlugins((await load()).plugins);
      setError(undefined);
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);

  const show = useCallback(() => {
    setOpen(true);
    setPlugins(undefined);
    setError(undefined);
    void fetchPlugins();
  }, [fetchPlugins]);

  const close = useCallback(() => setOpen(false), []);
  const refresh = useCallback(async () => { if (open) await fetchPlugins(); }, [open, fetchPlugins]);

  return { open, plugins, error, show, close, refresh };
}

interface MarketplaceDialogProps {
  readonly title: string;
  readonly marketplace: Marketplace;
  /** Id of the plugin an install is running for. */
  readonly busy?: string;
  /** What the CLI printed for the last action. */
  readonly output?: string;
  /** Shown when no marketplace lists anything. */
  readonly emptyHint: string;
  readonly onInstall: (plugin: AvailablePlugin) => void;
}

/** Searchable list of installable plugins, shown as a popup over the Library. */
export function MarketplaceDialog({ title, marketplace, busy, output, emptyHint, onInstall }: MarketplaceDialogProps) {
  const [query, setQuery] = useState('');
  const { plugins, error } = marketplace;
  const needle = query.trim().toLowerCase();
  const shown = (plugins ?? []).filter((p) => !needle || `${p.id} ${p.description ?? ''}`.toLowerCase().includes(needle));

  return (
    <Modal title={title} onClose={marketplace.close} className="int-market">
      <label className="form-field">Search
        <input className="text-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. playwright" autoFocus data-autofocus />
      </label>
      {output && <pre className="int-output" aria-label="Output from the last install">{output}</pre>}
      <div className="int-market-body">
        {error && (
          <div className="detail-load-error" role="alert">
            <p>Couldn’t load the marketplace. {error}</p>
            <button className="btn" onClick={() => void marketplace.refresh()}>Try again</button>
          </div>
        )}
        {!plugins && !error && <p className="workspace-loading" role="status">Loading marketplace…</p>}
        {plugins?.length === 0 && <p className="detail-empty-text">{emptyHint}</p>}
        {plugins && plugins.length > 0 && (
          <p className="int-hint" role="status">{needle ? `${shown.length} of ${plugins.length} plugins match` : `${plugins.length} plugins`}</p>
        )}
        <ul className="ops-list" aria-label="Plugins available to install">
          {shown.map((p) => (
            <li key={p.id} className="ops-row">
              <div className="ops-row-main"><strong>{p.name} <span className="int-tag">{p.marketplace}</span></strong>{p.description && <small>{p.description}</small>}</div>
              <div className="ops-row-actions">
                {p.installed ? <span className="int-tag">Installed</span> : (
                  <button className="btn btn-small" disabled={!!busy} aria-label={`Install ${p.name}`} onClick={() => onInstall(p)}>
                    {busy === p.id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
