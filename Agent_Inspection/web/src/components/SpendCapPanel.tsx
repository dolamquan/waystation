import { useEffect, useState, type FormEvent } from 'react';
import { api, type SpendCapConfig, type SpendCapView, type SpendStatus } from '../api.ts';
import type { SpendScope } from '../../../daemon/guard/spendCap.ts';
import { formatUsd } from '../format.ts';
import { useSpendCap } from '../useSpendCap.ts';
import { Icon } from './Icon.tsx';

type Notify = (text: string, kind?: 'ok' | 'error') => void;

interface ProjectRow {
  readonly key: number;
  readonly project: string;
  readonly amount: string;
}

interface Draft {
  readonly dailyUsd: string;
  readonly projects: readonly ProjectRow[];
  readonly quotaPausePercent: string;
  readonly constrainRunning: boolean;
}

const QUOTA_CHOICES = ['', '80', '90', '95'] as const;
let rowKey = 0;

function draftOf(config: SpendCapConfig): Draft {
  return {
    dailyUsd: config.dailyUsd === undefined ? '' : String(config.dailyUsd),
    projects: Object.entries(config.projects).map(([project, amount]) => ({ key: ++rowKey, project, amount: String(amount) })),
    quotaPausePercent: config.quotaPausePercent === undefined ? '' : String(config.quotaPausePercent),
    constrainRunning: config.constrainRunning,
  };
}

function bodyOf(draft: Draft): unknown {
  return {
    dailyUsd: draft.dailyUsd.trim(),
    projects: Object.fromEntries(draft.projects.filter((row) => row.project.trim()).map((row) => [row.project.trim(), row.amount.trim()])),
    quotaPausePercent: draft.quotaPausePercent,
    constrainRunning: draft.constrainRunning,
  };
}

const scopeName = (scope: SpendScope): string => (scope.scope === 'fleet' ? 'All agents' : scope.project ?? 'Project');
const STATE_LABEL: Record<SpendScope['state'], string> = { ok: 'Within cap', near: 'Nearly there', over: 'Over cap' };

function SpendMeters({ status }: { readonly status: SpendStatus }) {
  if (status.scopes.length === 0) return <p className="spend-cap-empty">No caps set. Today so far: about {formatUsd(status.totalUsd)}.</p>;
  return (
    <ul className="spend-meters">
      {status.scopes.map((scope) => {
        const percent = Math.min(100, Math.round((scope.spentUsd / scope.limitUsd) * 100));
        return (
          <li key={`${scope.scope}:${scope.project ?? ''}`} className={`spend-meter spend-${scope.state}`}>
            <div className="spend-meter-head">
              <strong>{scopeName(scope)}</strong>
              <span>{formatUsd(scope.spentUsd)} of {formatUsd(scope.limitUsd)}</span>
              <span className="spend-meter-state">{STATE_LABEL[scope.state]}</span>
            </div>
            <div className="spend-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${scopeName(scope)}: ${percent}% of today's cap`}>
              <span style={{ width: `${percent}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface SpendCapPanelProps {
  readonly projects: readonly string[];
  readonly notify: Notify;
}

/** Usage & schedules → daily caps for the whole fleet and per project, and the quota pause. */
export function SpendCapPanel({ projects, notify }: SpendCapPanelProps) {
  const spend = useSpendCap(true);
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  // The form starts from the saved settings once they arrive; later polls only refresh the meters.
  useEffect(() => { if (spend.view && !draft) setDraft(draftOf(spend.view.config)); }, [spend.view, draft]);

  const update = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const setRow = (key: number, patch: Partial<ProjectRow>) =>
    update({ projects: (draft?.projects ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)) });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    try {
      const saved: SpendCapView = await api.saveSpendCap(bodyOf(draft));
      spend.replace(saved);
      setDraft(draftOf(saved.config));
      notify('Spend cap saved');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ops-section workspace-panel spend-cap" aria-labelledby="spend-cap-title">
      <div className="spend-cap-head">
        <h2 id="spend-cap-title">Daily spend cap</h2>
        <p>Estimates at list price, for today. Over a cap, schedules and factory stages wait, and running agents launched here need your approval for each tool call. You can still launch agents yourself.</p>
      </div>
      {spend.error && <p className="form-error" role="alert">{spend.error}</p>}
      {spend.view && <SpendMeters status={spend.view.status} />}
      {draft && (
        <form className="spend-cap-form" onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>All agents, per day (USD)</span>
            <input className="text-input" inputMode="decimal" value={draft.dailyUsd} onChange={(e) => update({ dailyUsd: e.target.value })} placeholder="No cap" />
          </label>
          <fieldset className="spend-projects">
            <legend>Per project, per day</legend>
            {draft.projects.map((row) => (
              <div key={row.key} className="spend-project-row">
                <input className="text-input" list="spend-project-names" value={row.project} onChange={(e) => setRow(row.key, { project: e.target.value })} placeholder="Project folder name" aria-label="Project folder name" />
                <input className="text-input" inputMode="decimal" value={row.amount} onChange={(e) => setRow(row.key, { amount: e.target.value })} placeholder="USD" aria-label={`Daily cap for ${row.project || 'this project'}`} />
                <button type="button" className="icon-btn" onClick={() => update({ projects: draft.projects.filter((r) => r.key !== row.key) })} aria-label={`Remove the cap for ${row.project || 'this project'}`}><Icon name="close" size={14} /></button>
              </div>
            ))}
            <datalist id="spend-project-names">{projects.map((name) => <option key={name} value={name} />)}</datalist>
            <button type="button" className="btn btn-small" onClick={() => update({ projects: [...draft.projects, { key: ++rowKey, project: '', amount: '' }] })}><Icon name="plus" size={14} />Add a project cap</button>
          </fieldset>
          <label className="field">
            <span>Hold schedules and factory stages when a plan window reaches</span>
            <select className="sort-select" value={draft.quotaPausePercent} onChange={(e) => update({ quotaPausePercent: e.target.value })}>
              {QUOTA_CHOICES.map((value) => <option key={value} value={value}>{value ? `${value}% used` : 'Never'}</option>)}
            </select>
          </label>
          <label className="check-field">
            <input type="checkbox" checked={draft.constrainRunning} onChange={(e) => update({ constrainRunning: e.target.checked })} />
            <span>Over a cap, require approval for running agents launched here</span>
          </label>
          <div className="spend-cap-actions">
            <button className="btn btn-go" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save caps'}</button>
          </div>
        </form>
      )}
    </section>
  );
}

interface SpendBannerProps {
  readonly status: SpendStatus | undefined;
  readonly onReview: () => void;
}

/** Top-of-page notice once any cap is nearly used or exceeded. */
export function SpendBanner({ status, onReview }: SpendBannerProps) {
  const over = status?.scopes.filter((scope) => scope.state === 'over') ?? [];
  const near = status?.scopes.filter((scope) => scope.state === 'near') ?? [];
  const worst = over[0] ?? near[0];
  if (!worst) return null;
  const affected = over.length + near.length;
  const message = over.length
    ? `${scopeName(worst)} spent about ${formatUsd(worst.spentUsd)} today, over the ${formatUsd(worst.limitUsd)} cap. Schedules and factory stages are waiting.`
    : `${scopeName(worst)} has used ${formatUsd(worst.spentUsd)} of its ${formatUsd(worst.limitUsd)} cap today.`;
  return (
    <div className={`spend-banner ${over.length ? 'spend-banner-over' : 'spend-banner-near'}`} role="status">
      <Icon name="alert" size={16} />
      <span>{message}{affected > 1 ? ` (${affected} caps affected)` : ''}</span>
      <button className="btn btn-small" onClick={onReview}>Review caps</button>
    </div>
  );
}
