import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  integrationsApi, type AvailablePlugin, type McpPreset, type McpServerInput, type McpServerView, type McpTestResult,
  type McpTransport, type PluginView,
} from '../../library/integrationsApi.ts';
import '../../library/integrations.css';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import type { LibraryPanelProps } from './LibraryView.tsx';

type Notify = LibraryPanelProps['notify'];

interface Pending {
  readonly title: string;
  readonly body: string;
  readonly label: string;
  readonly action: () => Promise<void>;
}

interface Pair {
  readonly key: string;
  readonly value: string;
}

/** What the server form starts from: a preset, an existing server, or a blank custom server. */
interface Draft {
  readonly id?: string;
  readonly input: McpServerInput;
  /** Secrets already stored (edit) or required (preset): shown as rows whose value is left blank. */
  readonly secretNames: readonly string[];
}

const BLANK: Draft = { input: { name: '', transport: 'stdio', command: '', args: [] }, secretNames: [] };

const toPairs = (map: Readonly<Record<string, string>> | undefined): Pair[] => Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
const fromPairs = (pairs: readonly Pair[]): Record<string, string> =>
  Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));
const errorText = (err: unknown) => (err as Error).message;

/** MCP servers and Claude Code plugins agents can be launched with. */
export function IntegrationsPanel({ notify }: LibraryPanelProps) {
  const [pending, setPending] = useState<Pending>();
  const ask = (p: Pending) => setPending(p);
  return (
    <div className="ops-view">
      <McpSection notify={notify} ask={ask} />
      <PluginsSection notify={notify} ask={ask} />
      <AnimatePresence>
        {pending && (
          <Confirm title={pending.title} body={pending.body} confirmLabel={pending.label} danger
            onConfirm={() => void pending.action()} onClose={() => setPending(undefined)} />
        )}
      </AnimatePresence>
    </div>
  );
}

interface SectionProps {
  readonly notify: Notify;
  readonly ask: (pending: Pending) => void;
}

// ---- MCP servers -----------------------------------------------------------------------------------

function McpSection({ notify, ask }: SectionProps) {
  const [servers, setServers] = useState<readonly McpServerView[]>([]);
  const [presets, setPresets] = useState<readonly McpPreset[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>();
  const [tests, setTests] = useState<Readonly<Record<string, McpTestResult | 'running'>>>({});

  const load = useCallback(async () => {
    try {
      const data = await integrationsApi.mcp();
      setServers(data.servers);
      setPresets(data.presets);
      setError(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok);
      await load();
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };

  const test = async (server: McpServerView) => {
    setTests((t) => ({ ...t, [server.id]: 'running' }));
    try {
      const { result } = await integrationsApi.testMcp(server.id);
      setTests((t) => ({ ...t, [server.id]: result }));
    } catch (err) {
      setTests((t) => ({ ...t, [server.id]: { ok: false, error: errorText(err) } }));
    }
  };

  const fromPreset = (preset: McpPreset) => setDraft({ input: preset.input, secretNames: preset.requiredSecrets });
  const edit = (s: McpServerView) => setDraft({
    id: s.id,
    input: { name: s.name, label: s.label, transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url, defaultOn: s.defaultOn, presetId: s.presetId },
    secretNames: s.secretNames,
  });

  return (
    <section className="ops-section" aria-labelledby="int-mcp">
      <div className="section-heading">
        <div><h2 id="int-mcp">Connected tools <span className="status-pill">MCP</span></h2><p>Give agents a browser, access to GitHub and more. Start with a ready-made connection below.</p></div>
        <button className="btn" onClick={() => setDraft(draft ? undefined : BLANK)} aria-expanded={!!draft}><Icon name="plus" size={15} />Custom server</button>
      </div>
      {error && <div className="detail-load-error" role="alert"><p>Couldn’t load MCP servers. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
      {draft && (
        <McpForm key={draft.id ?? draft.input.presetId ?? 'custom'} draft={draft} notify={notify}
          onCancel={() => setDraft(undefined)} onSaved={() => { setDraft(undefined); void load(); }} />
      )}
      {loading && <p className="workspace-loading" role="status">Loading connected tools…</p>}
      {!loading && !error && servers.length === 0 && !draft && <p className="detail-empty-text">Connect your first tool with a quick connection below, or add a custom server.</p>}
      <ul className="ops-list" aria-label="Your MCP servers">
        {servers.map((s) => (
          <McpRow key={s.id} server={s} test={tests[s.id]} onTest={() => void test(s)} onEdit={() => edit(s)}
            onDefault={() => void act(() => integrationsApi.setMcpDefault(s.id, !s.defaultOn), s.defaultOn ? `${s.label} no longer default` : `${s.label} is on by default`)}
            onDelete={() => ask({ title: `Delete ${s.label}?`, body: 'Its stored secrets are deleted too. Running agents keep it until they stop.', label: 'Delete', action: () => act(() => integrationsApi.deleteMcp(s.id), `${s.label} deleted`) })} />
        ))}
      </ul>
      <h3 className="connection-presets-heading">Quick connections <small>Choose a tool to get started</small></h3>
      <ul className="int-presets" aria-label="MCP server presets">
        {presets.map((p) => (
          <li key={p.id} className="int-preset">
            <strong>{p.label}</strong>
            <p>{p.description}</p>
            <button className="btn btn-small" onClick={() => fromPreset(p)} aria-label={`Add ${p.label}`}><Icon name="plus" size={13} />Set up {p.label}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface McpRowProps {
  readonly server: McpServerView;
  readonly test?: McpTestResult | 'running';
  readonly onTest: () => void;
  readonly onEdit: () => void;
  readonly onDefault: () => void;
  readonly onDelete: () => void;
}

function McpRow({ server: s, test, onTest, onEdit, onDefault, onDelete }: McpRowProps) {
  const target = s.transport === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}` : s.url;
  return (
    <li className="ops-row">
      <div className="ops-row-main">
        <strong>{s.label} <span className="int-tag">{s.name} · {s.transport}</span></strong>
        <small>{target}</small>
        {s.secretNames.length > 0 && <small>Secrets: {s.secretNames.join(', ')}</small>}
        {test && <TestLine result={test} />}
      </div>
      <div className="ops-row-actions">
        <span className="int-switch-label">Default
          <button className="detail-switch" role="switch" aria-checked={s.defaultOn} aria-label={`${s.label} on by default`} onClick={onDefault}><span /></button>
        </span>
        <button className="btn btn-small" onClick={onTest} disabled={test === 'running'}>{test === 'running' ? 'Testing…' : 'Test'}</button>
        <button className="btn btn-small" onClick={onEdit} aria-label={`Edit ${s.label}`}>Edit</button>
        <button className="icon-btn" aria-label={`Delete ${s.label}`} onClick={onDelete}><Icon name="close" size={14} /></button>
      </div>
    </li>
  );
}

function TestLine({ result }: { readonly result: McpTestResult | 'running' }) {
  if (result === 'running') return <small className="int-test" role="status">Connecting…</small>;
  if (!result.ok) return <small className="int-test int-test-fail" role="status">Failed: {result.error}</small>;
  const tools = result.tools ?? [];
  return <small className="int-test int-test-ok" role="status">Connected · {tools.length} tool{tools.length === 1 ? '' : 's'}{tools.length ? `: ${tools.join(', ')}` : ''}</small>;
}

interface McpFormProps {
  readonly draft: Draft;
  readonly notify: Notify;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}

function McpForm({ draft, notify, onCancel, onSaved }: McpFormProps) {
  const { input } = draft;
  const [name, setName] = useState(input.name);
  const [label, setLabel] = useState(input.label ?? '');
  const [transport, setTransport] = useState<McpTransport>(input.transport);
  const [command, setCommand] = useState(input.command ?? '');
  const [args, setArgs] = useState((input.args ?? []).join('\n'));
  const [env, setEnv] = useState<readonly Pair[]>(toPairs(input.env));
  const [url, setUrl] = useState(input.url ?? '');
  const [secrets, setSecrets] = useState<readonly Pair[]>(draft.secretNames.map((key) => ({ key, value: '' })));
  const [defaultOn, setDefaultOn] = useState(input.defaultOn ?? false);
  const [busy, setBusy] = useState(false);
  const stdio = transport === 'stdio';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // A blank value keeps a stored secret when editing; a removed row is not sent.
    const secretValues = Object.fromEntries(secrets.filter((p) => p.key.trim() && (p.value || !draft.id)).map((p) => [p.key.trim(), p.value]));
    const removed = draft.secretNames.filter((n) => draft.id && !secrets.some((p) => p.key.trim() === n));
    const body: McpServerInput = {
      name: name.trim(), label: label.trim() || undefined, transport, defaultOn, presetId: input.presetId,
      ...(stdio
        ? { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: fromPairs(env) }
        : { url: url.trim() }),
      secrets: { ...secretValues, ...Object.fromEntries(removed.map((n) => [n, ''])) },
    };
    try {
      if (draft.id) await integrationsApi.updateMcp(draft.id, body);
      else await integrationsApi.createMcp(body);
      notify(draft.id ? `Saved ${body.name}` : `Added ${body.name}`);
      onSaved();
    } catch (err) {
      notify(errorText(err), 'error');
      setBusy(false);
    }
  };

  return (
    <form className="form ops-form" onSubmit={(e) => void submit(e)} aria-label={draft.id ? `Edit ${input.name}` : 'New MCP server'}>
      <div className="form-pair">
        <label>Name (tool prefix)<input className="text-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} pattern="[a-z][a-z0-9_\-]*" placeholder="e.g. playwright" /></label>
        <label>Label<input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Shown in New agent" /></label>
        <label>Transport
          <select className="text-input" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
            <option value="stdio">Local command (stdio)</option>
            <option value="http">Remote (streamable HTTP)</option>
            <option value="sse">Remote (SSE, Claude only)</option>
          </select>
        </label>
      </div>
      {stdio ? (
        <>
          <label>Command<input className="text-input" value={command} onChange={(e) => setCommand(e.target.value)} required placeholder="npx" /></label>
          <label>Arguments, one per line<textarea className="text-input" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'-y\n@playwright/mcp@latest'} /></label>
          <PairsEditor legend="Environment (not secret)" pairs={env} onChange={setEnv} keyLabel="Variable" valueLabel="Value" />
        </>
      ) : (
        <label>URL<input className="text-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/mcp" /></label>
      )}
      <PairsEditor legend={stdio ? 'Secret environment variables' : 'Secret headers'} pairs={secrets} onChange={setSecrets} secret
        keyLabel={stdio ? 'Variable' : 'Header'} valueLabel="Value" stored={draft.id ? draft.secretNames : []} />
      <p className="int-hint">Secrets are stored locally on this machine and never shown again.{!stdio && ' For Authorization, a bare token is sent as “Bearer <token>”.'}</p>
      <label className="check"><input type="checkbox" checked={defaultOn} onChange={(e) => setDefaultOn(e.target.checked)} /> Pre-select in New agent</label>
      <footer className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-go" disabled={busy}>{draft.id ? 'Save' : 'Add server'}</button>
      </footer>
    </form>
  );
}

interface PairsEditorProps {
  readonly legend: string;
  readonly pairs: readonly Pair[];
  readonly onChange: (pairs: readonly Pair[]) => void;
  readonly keyLabel: string;
  readonly valueLabel: string;
  readonly secret?: boolean;
  readonly stored?: readonly string[];
}

function PairsEditor({ legend, pairs, onChange, keyLabel, valueLabel, secret, stored = [] }: PairsEditorProps) {
  const update = (index: number, patch: Partial<Pair>) => onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <fieldset className="int-pairs">
      <legend className="int-tag">{legend}</legend>
      {pairs.map((p, i) => (
        <div key={i} className="int-pair">
          <input className="text-input" aria-label={`${keyLabel} ${i + 1}`} value={p.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={keyLabel} />
          <input className="text-input" aria-label={`${valueLabel} for ${p.key || `${keyLabel} ${i + 1}`}`} type={secret ? 'password' : 'text'} autoComplete="off"
            value={p.value} onChange={(e) => update(i, { value: e.target.value })}
            placeholder={secret && stored.includes(p.key) ? 'Stored (leave blank to keep)' : valueLabel} />
          <button type="button" className="icon-btn" aria-label={`Remove ${p.key || 'row'}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
        </div>
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange([...pairs, { key: '', value: '' }])}><Icon name="plus" size={13} />Add {keyLabel.toLowerCase()}</button>
    </fieldset>
  );
}

// ---- plugins ----------------------------------------------------------------------------------------

function PluginsSection({ notify, ask }: SectionProps) {
  const [plugins, setPlugins] = useState<readonly PluginView[]>([]);
  const [available, setAvailable] = useState<readonly AvailablePlugin[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [output, setOutput] = useState<string>();
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setPlugins((await integrationsApi.plugins()).plugins);
      setError(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const browse = async () => {
    try {
      setAvailable((await integrationsApi.availablePlugins()).plugins);
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };

  /** Runs a `claude plugin` action, which can take a while; shows what the CLI printed. */
  const runCli = async (id: string, fn: () => Promise<{ output: string }>, ok: string) => {
    setBusy(id);
    try {
      const result = await fn();
      setOutput(result.output || undefined);
      notify(ok);
      await load();
      if (available) await browse();
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setBusy(undefined);
    }
  };

  const setDefault = async (p: PluginView) => {
    try {
      await integrationsApi.setPluginDefault(p.id, !p.defaultOn);
      await load();
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (available ?? []).filter((p) => !needle || `${p.id} ${p.description ?? ''}`.toLowerCase().includes(needle));

  return (
    <section className="ops-section" aria-labelledby="int-plugins">
      <div className="section-heading">
        <div><h2 id="int-plugins">Claude Code plugins</h2><p>Plugins enabled globally load in every Claude agent. Others load only for agents you pick them for. Codex agents ignore plugins.</p></div>
        <button className="btn" onClick={() => (available ? setAvailable(undefined) : void browse())} aria-expanded={!!available}><Icon name="search" size={15} />Browse marketplaces</button>
      </div>
      {error && <div className="detail-load-error" role="alert"><p>Couldn’t load plugins. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
      {output && <pre className="int-output" aria-label="Output from claude plugin">{output}</pre>}
      {loading && <p className="workspace-loading" role="status">Loading plugins…</p>}
      {!loading && plugins.length === 0 && !error && <p className="detail-empty-text">No plugins installed. Browse your marketplaces to install one.</p>}
      <ul className="ops-list" aria-label="Installed plugins">
        {plugins.map((p) => (
          <li key={p.id} className="ops-row">
            <div className="ops-row-main">
              <strong>{p.name} <span className="int-tag">{p.marketplace}{p.version ? ` · ${p.version}` : ''}</span></strong>
              {p.description && <small>{p.description}</small>}
              <small>{p.skills} skill{p.skills === 1 ? '' : 's'} · {p.mcpServers} MCP server{p.mcpServers === 1 ? '' : 's'}</small>
            </div>
            <div className="ops-row-actions">
              <span className="int-switch-label">Default
                <button className="detail-switch" role="switch" aria-checked={p.defaultOn} aria-label={`${p.name} pre-selected in New agent`} onClick={() => void setDefault(p)}><span /></button>
              </span>
              <span className="int-switch-label">Global
                <button className="detail-switch" role="switch" aria-checked={p.enabledGlobally} aria-label={`${p.name} enabled for all Claude sessions`} disabled={busy === p.id}
                  onClick={() => void runCli(p.id, () => integrationsApi.setPluginEnabled(p.id, !p.enabledGlobally), p.enabledGlobally ? `${p.name} disabled` : `${p.name} enabled`)}><span /></button>
              </span>
              <button className="btn btn-small btn-danger" disabled={busy === p.id}
                onClick={() => ask({ title: `Uninstall ${p.name}?`, body: 'It is removed from Claude Code for every session, not just Waystation agents.', label: 'Uninstall', action: () => runCli(p.id, () => integrationsApi.uninstallPlugin(p.id), `${p.name} uninstalled`) })}>
                {busy === p.id ? 'Working…' : 'Uninstall'}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {available && (
        <div className="ops-form">
          <label className="form-field">Search marketplaces<input className="text-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. playwright" /></label>
          {available.length === 0 && <p className="detail-empty-text">No marketplaces found. Add one with “claude plugin marketplace add”.</p>}
          <ul className="ops-list int-browse" aria-label="Plugins available to install">
            {shown.map((p) => (
              <li key={p.id} className="ops-row">
                <div className="ops-row-main"><strong>{p.name} <span className="int-tag">{p.marketplace}</span></strong>{p.description && <small>{p.description}</small>}</div>
                <div className="ops-row-actions">
                  {p.installed ? <span className="int-tag">Installed</span> : (
                    <button className="btn btn-small" disabled={!!busy} aria-label={`Install ${p.name}`}
                      onClick={() => ask({ title: `Install ${p.name}?`, body: `Runs “claude plugin install ${p.id}”. Plugins run code on this machine: install only ones you trust.`, label: 'Install', action: () => runCli(p.id, () => integrationsApi.installPlugin(p.id), `${p.name} installed`) })}>
                      {busy === p.id ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
