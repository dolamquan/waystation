import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  INBOX_CHANNEL_ID, KIND_SPECS, kindLabel, kindSpec, notifyApi,
  type ChannelKind, type NotificationEntry, type NotifyChannelView,
} from '../../library/notifyApi.ts';
import '../../library/notify.css';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { PanelEmpty } from '../SectionTabs.tsx';
import type { LibraryPanelProps } from './LibraryView.tsx';
import { UPDATES_CHANGED_EVENT } from './UpdatesBadge.tsx';

const POLL_MS = 20_000;
const INBOX_LIMIT = 100;

type Notify = LibraryPanelProps['notify'];

interface Loaded {
  readonly channels: readonly NotifyChannelView[];
  readonly notifications: readonly NotificationEntry[];
  readonly unread: number;
}

/** The Updates inbox plus where else updates go: Slack, Discord, email, ntfy, webhooks, desktop. */
export function NotificationsPanel({ notify }: LibraryPanelProps) {
  const [data, setData] = useState<Loaded>({ channels: [], notifications: [], unread: 0 });
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [channels, inbox] = await Promise.all([notifyApi.channels(), notifyApi.notifications(INBOX_LIMIT)]);
      setData({ channels: channels.channels, notifications: inbox.notifications, unread: inbox.unread });
      setError(undefined);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify(ok);
      await load();
      window.dispatchEvent(new Event(UPDATES_CHANGED_EVENT));
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  return (
    <div className="ops-view notify-view">
      {error && <div className="detail-load-error" role="alert"><p>Couldn’t load notifications. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
      {!loaded && !error && <p className="workspace-loading" role="status">Loading updates and channels…</p>}
      {loaded && <>
      <UpdatesSection data={data} channels={data.channels} onAct={act} onRefresh={() => void load()} />
      <ChannelsSection channels={data.channels} onAct={act} notify={notify} onChanged={() => void load()} />
      </>}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function UpdatesSection({ data, channels, onAct, onRefresh }: { readonly data: Loaded; readonly channels: readonly NotifyChannelView[]; readonly onAct: Act; readonly onRefresh: () => void }) {
  const labelOf = (id: string) => channels.find((c) => c.id === id)?.label ?? id;
  return (
    <section className="ops-section" aria-labelledby="notify-updates">
      <div className="section-heading">
        <div><h2 id="notify-updates">Your updates{data.unread > 0 && <span className="section-count">{data.unread} unread</span>}</h2><p>Progress and results from your agents and scheduled tasks.</p></div>
        <div className="ops-row-actions">
          {data.unread > 0 && <button className="btn btn-small" onClick={() => void onAct(() => notifyApi.markRead({ all: true }), 'All marked read')}><Icon name="check" size={14} />Mark all read</button>}
          <button className="icon-btn" aria-label="Refresh updates" title="Refresh" onClick={onRefresh}><Icon name="refresh" size={16} /></button>
        </div>
      </div>
      {data.notifications.length === 0 && <PanelEmpty icon="message" title="You’re all caught up"><p>Agent updates will appear here. Choose a notification channel in New agent, or enable updates for a schedule.</p></PanelEmpty>}
      <ul className="ops-list notify-inbox">
        {data.notifications.map((entry) => (
          <li key={entry.id} className={`ops-row notify-entry notify-${entry.level ?? 'info'}${entry.read ? '' : ' notify-unread'}`}>
            <span className="notify-mark" aria-hidden="true"><Icon name={levelIcon(entry.level)} size={16} /></span>
            <div className="ops-row-main">
              <strong>{entry.title}{!entry.read && <span className="sr-only"> (unread)</span>}</strong>
              {entry.body && <p className="notify-body">{entry.body}</p>}
              <small>{entry.source ?? 'waystation'} · <time dateTime={new Date(entry.ts).toISOString()}>{new Date(entry.ts).toLocaleString()}</time></small>
              {entry.deliveries.length > 0 && (
                <small className="notify-deliveries">
                  {entry.deliveries.map((d) => (
                    <span key={d.channelId} className={d.ok ? 'notify-ok' : 'notify-failed'} title={d.error}>{d.ok ? '✓' : '✕'} {labelOf(d.channelId)}{d.ok ? '' : `: ${d.error ?? 'failed'}`}</span>
                  ))}
                </small>
              )}
            </div>
            {!entry.read && (
              <div className="ops-row-actions">
                <button className="btn btn-small btn-ghost" onClick={() => void onAct(() => notifyApi.markRead({ ids: [entry.id] }))}>Mark read</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const levelIcon = (level: NotificationEntry['level']): 'check' | 'alert' | 'info' =>
  level === 'success' ? 'check' : level === 'warning' || level === 'error' ? 'alert' : 'info';

interface ChannelsProps {
  readonly channels: readonly NotifyChannelView[];
  readonly onAct: Act;
  readonly notify: Notify;
  readonly onChanged: () => void;
}

function ChannelsSection({ channels, onAct, notify, onChanged }: ChannelsProps) {
  const [editing, setEditing] = useState<NotifyChannelView | 'new'>();
  const [confirm, setConfirm] = useState<NotifyChannelView>();

  const test = (channel: NotifyChannelView) => onAct(async () => {
    const { result } = await notifyApi.test(channel.id);
    if (!result.ok) throw new Error(`${channel.label}: ${result.error ?? 'test failed'}`);
  }, `Test sent to ${channel.label}`);

  return (
    <section className="ops-section" aria-labelledby="notify-channels">
      <div className="section-heading">
        <div><h2 id="notify-channels">Delivery channels</h2><p>Get updates in Slack, Discord, email or on your desktop.</p></div>
        <button className="btn btn-go" onClick={() => setEditing((v) => (v === 'new' ? undefined : 'new'))} aria-expanded={editing === 'new'}><Icon name="plus" size={15} />Add channel</button>
      </div>
      {editing === 'new' && <ChannelForm notify={notify} onDone={() => { setEditing(undefined); onChanged(); }} />}
      <ul className="ops-list">
        {channels.map((channel) => (
          <li key={channel.id} className="notify-channel-item">
            <div className="ops-row">
              <div className="ops-row-main">
                <strong>{channel.label} <span className="meta-chip">{kindLabel(channel.kind)}</span></strong>
                <small>{channelSummary(channel)}</small>
                {channel.lastError && <small className="error-text">Last error: {channel.lastError}</small>}
              </div>
              <div className="ops-row-actions">
                {channel.id !== INBOX_CHANNEL_ID && (
                  <button className="detail-switch" role="switch" aria-checked={channel.enabled} aria-label={`${channel.label} enabled`} onClick={() => void onAct(() => notifyApi.update(channel.id, { enabled: !channel.enabled }), channel.enabled ? `${channel.label} paused` : `${channel.label} on`)}><span /></button>
                )}
                <button className="btn btn-small" onClick={() => void test(channel)}><Icon name="send" size={13} />Test</button>
                {channel.id !== INBOX_CHANNEL_ID && (
                  <>
                    <button className="btn btn-small" aria-expanded={editing !== 'new' && editing?.id === channel.id} onClick={() => setEditing((v) => (v !== 'new' && v?.id === channel.id ? undefined : channel))}>Edit</button>
                    <button className="icon-btn" aria-label={`Delete ${channel.label}`} onClick={() => setConfirm(channel)}><Icon name="close" size={14} /></button>
                  </>
                )}
              </div>
            </div>
            {editing !== 'new' && editing?.id === channel.id && <ChannelForm existing={channel} notify={notify} onDone={() => { setEditing(undefined); onChanged(); }} />}
          </li>
        ))}
      </ul>
      <AnimatePresence>
        {confirm && (
          <Confirm
            title={`Delete ${confirm.label}?`}
            body="Its stored secrets are deleted too. Agents and schedules using it will skip it."
            confirmLabel="Delete"
            danger
            onConfirm={() => void onAct(() => notifyApi.remove(confirm.id), 'Channel deleted')}
            onClose={() => setConfirm(undefined)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function channelSummary(channel: NotifyChannelView): string {
  const parts = [
    channel.id === INBOX_CHANNEL_ID ? 'Always on · cannot be removed' : channel.enabled ? 'On' : 'Paused',
    channel.config.to ? `to ${channel.config.to}` : '',
    channel.config.topic ? `topic ${channel.config.topic}` : '',
    channel.lastSentAt ? `last sent ${new Date(channel.lastSentAt).toLocaleString()}` : 'nothing sent yet',
  ];
  return parts.filter(Boolean).join(' · ');
}

interface FormProps {
  readonly existing?: NotifyChannelView;
  readonly notify: Notify;
  readonly onDone: () => void;
}

function ChannelForm({ existing, notify, onDone }: FormProps) {
  const [kind, setKind] = useState<ChannelKind>((existing?.kind as ChannelKind | undefined) ?? 'slack');
  const spec = kindSpec(kind) ?? KIND_SPECS[0];
  const [label, setLabel] = useState(existing?.label ?? '');
  const [values, setValues] = useState<Readonly<Record<string, string>>>(existing?.config ?? spec.defaults ?? {});
  const [cleared, setCleared] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const pickKind = (next: ChannelKind) => {
    setKind(next);
    setValues(kindSpec(next)?.defaults ?? {});
  };
  const setValue = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const toggleCleared = (name: string) => setCleared((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const config = Object.fromEntries(spec.fields.filter((f) => !f.secret).map((f) => [f.name, (values[f.name] ?? '').trim()]).filter(([, v]) => v !== ''));
    const typed = spec.fields.filter((f) => f.secret && (values[f.name] ?? '') !== '').map((f) => [f.name, values[f.name]]);
    const secrets = Object.fromEntries([...typed, ...cleared.map((name) => [name, ''])]);
    try {
      if (existing) await notifyApi.update(existing.id, { label: label.trim(), config, secrets });
      else await notifyApi.create({ kind, label: label.trim(), config, secrets, enabled: true });
      notify(existing ? `Saved ${label.trim()}` : `Added ${label.trim()}. Use Test to check it.`);
      onDone();
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="form ops-form notify-form" onSubmit={(e) => void submit(e)}>
      {!existing && (
        <fieldset className="day-picker notify-kinds"><legend>Kind</legend>
          {KIND_SPECS.map((k) => (
            <button key={k.kind} type="button" className={`chip${k.kind === kind ? ' chip-on' : ''}`} aria-pressed={k.kind === kind} onClick={() => pickKind(k.kind)}>{k.label}</button>
          ))}
        </fieldset>
      )}
      <p className="notify-guide"><Icon name="info" size={14} /> <span>{spec.guide}</span></p>
      <label>Name<input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required placeholder={`e.g. ${spec.label} updates`} /></label>
      <div className="form-pair">
        {spec.fields.map((field) => {
          const stored = Boolean(field.secret && existing?.secretNames.includes(field.name));
          return (
            <label key={field.name}>
              {field.label}{field.required && !stored ? ' *' : ''}
              {field.type === 'select' ? (
                <select className="text-input" value={values[field.name] ?? field.options?.[0] ?? ''} onChange={(e) => setValue(field.name, e.target.value)}>
                  {field.options?.map((option) => <option key={option} value={option}>{option === 'true' ? 'Yes' : option === 'false' ? 'No (STARTTLS, port 587)' : option}</option>)}
                </select>
              ) : (
                <input
                  className="text-input"
                  type={field.secret ? 'password' : field.type ?? 'text'}
                  autoComplete={field.secret ? 'new-password' : 'off'}
                  value={values[field.name] ?? ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                  required={field.required && !stored}
                  maxLength={field.secret ? 2000 : 500}
                  placeholder={stored ? 'Stored — leave blank to keep' : field.placeholder}
                  disabled={cleared.includes(field.name)}
                />
              )}
              {stored && !field.required && (
                <span className="check notify-clear"><input type="checkbox" checked={cleared.includes(field.name)} onChange={() => toggleCleared(field.name)} /> Remove stored value</span>
              )}
            </label>
          );
        })}
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={busy || !label.trim()}>{existing ? 'Save' : 'Add channel'}</button>
      </footer>
    </form>
  );
}
