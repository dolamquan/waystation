import { useEffect, useId, useRef, useState } from 'react';
import { api, type Agent } from '../api.ts';
import type { PreviewView } from '../../../daemon/preview/types.ts';
import { Icon } from './Icon.tsx';
import '../preview.css';

interface AgentPreviewProps {
  readonly agent: Agent;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** Opens the Review tab, where diffs and results live. */
  readonly onReview: () => void;
}

type Device = 'fit' | 'phone';

/** While the app is getting ready the status changes quickly; once running, only a crash needs noticing. */
const POLL_STARTING_MS = 1200;
const POLL_RUNNING_MS = 5000;
const FIX_LOG_LINES = 25;
const UPDATED_FLASH_MS = 4000;
/** The daemon only ever reports loopback addresses; refuse anything else before framing it. */
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}\//;
const FINISHED: ReadonlySet<Agent['status']> = new Set(['idle', 'stopped']);

function usePreview(agentId: string) {
  const [view, setView] = useState<PreviewView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    let ignore = false;
    api.preview(agentId).then(
      (result) => { if (!ignore) { setView(result.preview); setError(undefined); } },
      (failure: Error) => { if (!ignore) setError(failure.message); },
    );
    return () => { ignore = true; };
  }, [agentId, poll]);

  const status = view?.status;
  useEffect(() => {
    if (status !== 'installing' && status !== 'starting' && status !== 'running') return undefined;
    const timer = setTimeout(() => setPoll((n) => n + 1), status === 'running' ? POLL_RUNNING_MS : POLL_STARTING_MS);
    return () => clearTimeout(timer);
  }, [status, view]);

  const act = async (action: () => Promise<{ preview: PreviewView }>) => {
    setBusy(true);
    try {
      setView((await action()).preview);
      setError(undefined);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { view, error, busy, act };
}

/** Reloads the frame when the agent finishes a turn, so the operator sees the newest version. */
function useReloadOnFinish(status: Agent['status']) {
  const [frameKey, setFrameKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const previous = useRef(status);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was === status || !FINISHED.has(status) || FINISHED.has(was)) return undefined;
    setFrameKey((key) => key + 1);
    setUpdatedAt(Date.now());
    const timer = setTimeout(() => setUpdatedAt(undefined), UPDATED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return { frameKey, updated: updatedAt !== undefined, reload: () => setFrameKey((key) => key + 1) };
}

function fixRequest(view: PreviewView): string {
  const command = view.plan.kind === 'script' ? view.plan.command : 'the app';
  const log = view.log.slice(-FIX_LOG_LINES).join('\n');
  return [
    `The live preview in Waystation couldn’t show this app. Please fix it so \`${command}\` starts the app and serves a web page.`,
    view.error ? `What Waystation saw: ${view.error}` : '',
    log ? `Last output:\n\`\`\`\n${log}\n\`\`\`` : '',
  ].filter(Boolean).join('\n\n');
}

function TechnicalDetails({ view }: { readonly view: PreviewView }) {
  if (view.plan.kind === 'none' || (!view.log.length && view.plan.kind === 'static')) return null;
  return (
    <details className="preview-details">
      <summary>Technical details<Icon name="chevronDown" size={13} /></summary>
      {view.plan.kind === 'script' && <p>Command: <code>{view.plan.command}</code>{view.plan.needsInstall ? <> (after <code>{view.plan.runner} install</code>)</> : null}</p>}
      {view.url && <p>Address: <code>{view.url}</code></p>}
      {view.log.length > 0 ? <pre aria-label="App output">{view.log.join('\n')}</pre> : <p>No output yet.</p>}
    </details>
  );
}

function StartCard({ view, busy, onStart }: { readonly view: PreviewView; readonly busy: boolean; readonly onStart: () => void }) {
  if (view.plan.kind === 'none') return null;
  const firstRun = view.plan.kind === 'script' && view.plan.needsInstall;
  return (
    <div className="preview-start">
      <span className="preview-start-icon"><Icon name="sparkle" size={22} /></span>
      <h4>See what your agent built</h4>
      <p>{view.plan.label}, right here.{firstRun ? ' The first time, Waystation installs the app’s packages, which can take a minute or two.' : ''}</p>
      <button className="btn btn-go" onClick={onStart} disabled={busy}><Icon name="play" size={15} />Start preview</button>
      {view.plan.kind === 'script' && <p className="preview-fineprint">Runs <code>{view.plan.command}</code> in <code>{view.folder}</code> on this computer only.</p>}
    </div>
  );
}

function Progress({ view }: { readonly view: PreviewView }) {
  const installing = view.status === 'installing';
  return (
    <div className="preview-progress" role="status">
      <span className="preview-spinner" aria-hidden="true" />
      <div>
        <strong>{installing ? 'Installing the app’s packages…' : 'Starting your app…'}</strong>
        <p>{installing ? 'This only happens the first time. It can take a minute or two.' : 'This usually takes a few seconds.'}</p>
        {view.log.length > 0 && <p className="preview-progress-line">{view.log[view.log.length - 1]}</p>}
      </div>
    </div>
  );
}

function Failure({ view, agent, busy, onRetry, notify }: { readonly view: PreviewView; readonly agent: Agent; readonly busy: boolean; readonly onRetry: () => void; readonly notify: AgentPreviewProps['notify'] }) {
  const [asking, setAsking] = useState(false);
  const askAgent = async () => {
    setAsking(true);
    try {
      await api.instruct(agent.id, fixRequest(view));
      notify(`Asked ${agent.name} to fix the app.`);
    } catch (failure) {
      notify((failure as Error).message, 'error');
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className="preview-failed" role="alert">
      <Icon name="alert" size={20} />
      <div>
        <strong>The preview isn’t running</strong>
        <p>{view.error ?? 'Your app stopped.'}</p>
        <div className="preview-actions">
          {agent.canInstruct && <button className="btn btn-small btn-go" onClick={() => void askAgent()} disabled={asking}><Icon name="message" size={14} />Ask {agent.name} to fix it</button>}
          <button className="btn btn-small" onClick={onRetry} disabled={busy}><Icon name="refresh" size={14} />Try again</button>
        </div>
      </div>
    </div>
  );
}

function LiveFrame({ agent, url, busy, onStop, notify }: { readonly agent: Agent; readonly url: string; readonly busy: boolean; readonly onStop: () => void; readonly notify: AgentPreviewProps['notify'] }) {
  const [device, setDevice] = useState<Device>('fit');
  const { frameKey, updated, reload } = useReloadOnFinish(agent.status);
  const openInBrowser = () => api.openPreview(agent.id).catch((failure: Error) => notify(failure.message, 'error'));
  return (
    <div className="preview-live">
      <div className="preview-toolbar">
        <span className="preview-address" title={url}><span className="connection-dot live" />{url.replace(/^http:\/\//, '').replace(/\/$/, '')}</span>
        {updated && <span className="preview-updated" role="status"><Icon name="sparkle" size={12} />Updated</span>}
        <div className="preview-device" role="group" aria-label="Preview size">
          <button aria-pressed={device === 'fit'} onClick={() => setDevice('fit')}>Full width</button>
          <button aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}>Phone</button>
        </div>
        <button className="icon-btn" aria-label="Reload preview" title="Reload" onClick={reload}><Icon name="refresh" size={15} /></button>
        <button className="icon-btn" aria-label="Open in your browser" title="Open in your browser" onClick={() => void openInBrowser()}><Icon name="expand" size={15} /></button>
        <button className="icon-btn" aria-label="Stop preview" title="Stop preview" onClick={onStop} disabled={busy}><Icon name="pause" size={15} /></button>
      </div>
      <div className={`preview-stage preview-${device}`}>
        <iframe key={frameKey} src={url} title={`Live preview of ${agent.project}`} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" />
      </div>
      <p className="outputs-hint">This is your app running on this computer. It refreshes when {agent.name} finishes a change.</p>
    </div>
  );
}

export function AgentPreview({ agent, notify, onReview }: AgentPreviewProps) {
  const uid = useId();
  const { view, error, busy, act } = usePreview(agent.id);
  const start = () => void act(() => api.startPreview(agent.id));
  const stop = () => void act(() => api.stopPreview(agent.id));
  const url = view?.url && LOOPBACK.test(view.url) ? view.url : undefined;
  return (
    <section className="preview" aria-labelledby={`${uid}-title`}>
      <div className="detail-section-heading"><div><h3 id={`${uid}-title`}>Preview</h3><p>Your app, live, as your agent builds it.</p></div></div>
      {error && <p className="outputs-error" role="alert">{error}</p>}
      {!view ? <p className="detail-empty-text">{error ? '' : 'Checking this folder…'}</p> : <>
        {view.plan.kind === 'none' && <div className="preview-empty"><Icon name="image" size={24} /><p>{view.plan.reason}</p><button className="btn btn-small" onClick={onReview}>See what changed instead<Icon name="arrow" size={13} /></button></div>}
        {view.status === 'idle' && <StartCard view={view} busy={busy} onStart={start} />}
        {(view.status === 'installing' || (view.status === 'starting' && !url)) && <Progress view={view} />}
        {view.status === 'failed' && <Failure view={view} agent={agent} busy={busy} onRetry={start} notify={notify} />}
        {view.status === 'running' && url && <LiveFrame agent={agent} url={url} busy={busy} onStop={stop} notify={notify} />}
        <TechnicalDetails view={view} />
      </>}
    </section>
  );
}
