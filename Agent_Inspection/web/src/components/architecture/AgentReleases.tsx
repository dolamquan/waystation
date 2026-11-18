import { useCallback, useEffect, useState } from 'react';
import type { DeploymentSummary, ReleaseGate, ReleasePolicy, ReleaseStage, ReleaseState } from '../../../../shared/agentPlatform.ts';
import type { AgentDataset, AgentEvaluator } from '../../../../shared/agentEvaluation.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { StatusBadge } from './ArchitectureUI.tsx';

const enc = encodeURIComponent;
const OVERRIDE_MIN = 10;
const OVERRIDE_MAX = 1000;
const DEFAULT_MIN_PASS_PERCENT = 80;
const percent = (value: number) => `${Math.round(value * 100)}%`;

export const RELEASE_EXPLAINER = 'Deploy creates a candidate. Triggers and webhooks run the production version. A candidate reaches production by passing its release policy.';
/** Deployments created before release gating have no stage; the backend treats them as production. */
export const stageOf = (d: Pick<DeploymentSummary, 'release'>): ReleaseStage => d.release ?? 'production';
const STAGE_LABEL: Record<ReleaseStage, string> = { candidate: 'Candidate', production: 'Production', retired: 'Retired' };

export function StageBadge({ stage }: { stage: ReleaseStage }) {
  return <StatusBadge tone={stage === 'production' ? 'success' : 'neutral'}>{STAGE_LABEL[stage]}</StatusBadge>;
}

type Version = ReleaseState['versions'][number];

/** Release lifecycle for one agent: every version with its stage, the candidate gate, promotion, rollback and the policy. */
export function AgentReleases({ architectureId, nodeId, project, currentId, onOpenVersion, onChanged }: { architectureId: string; nodeId: string; project: string; currentId?: string; onOpenVersion?: (id: string) => void; onChanged?: () => void }) {
  const [state, setState] = useState<ReleaseState>(); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const base = `/api/architectures/${enc(architectureId)}/nodes/${enc(nodeId)}`;
  const load = useCallback(async () => {
    try { setState(await request<ReleaseState>('GET', `${base}/releases`)); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  const act = async (path: string, body: unknown, success: string): Promise<boolean> => {
    setBusy(true); setError(''); setNotice('');
    try { await request('POST', path, body); setNotice(success); await load(); onChanged?.(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const production = state?.production;
  return <section className="release-panel" aria-label="Release">
    <p className="release-explainer"><Icon name="info" size={15} />{RELEASE_EXPLAINER}</p>
    <div className="release-production" role="status">{!state ? (error ? 'Release state unavailable.' : 'Loading release state…') : production
      ? <><StageBadge stage="production" /><span><strong>v{production.version}</strong> serves triggers and webhooks{production.promotion ? ` since ${new Date(production.promotion.at).toLocaleString()}` : ' (deployed before release gating)'}.</span></>
      : <><StatusBadge tone="warning">No production version</StatusBadge><span>Triggers and webhooks that follow production have nothing to run until a candidate is promoted.</span></>}
    </div>
    {error && <p className="arch-error" role="alert">{error}</p>}
    {notice && <p className="platform-success" role="status"><Icon name="check" size={14} />{notice}</p>}
    {state && <ol className="release-versions" aria-label="Versions">{state.versions.map(v => <ReleaseVersion key={v.id} version={v} busy={busy} current={v.id === currentId} onOpen={onOpenVersion}
      onPromote={override => act(`/api/agent-deployments/${enc(v.id)}/promote`, override ? { override } : {}, `v${v.version} is now in production.${override ? ' The override reason was recorded in the audit log.' : ''}`)}
      onRollback={() => act(`/api/agent-deployments/${enc(v.id)}/rollback`, {}, `Production rolled back to v${v.version}.`)} />)}</ol>}
    {state && !state.versions.length && <p className="agent-run-notice">No versions yet. Deploy this agent from Architecture design to create its first candidate.</p>}
    {state && <ReleasePolicyEditor key={state.policy?.updatedAt ?? 'none'} base={base} project={project} policy={state.policy} onSaved={() => { setNotice('Release policy saved. Candidate gates now use it.'); void load(); }} />}
  </section>;
}

function ReleaseVersion({ version: v, busy, current, onOpen, onPromote, onRollback }: { version: Version; busy: boolean; current: boolean; onOpen?: (id: string) => void; onPromote: (override?: string) => Promise<boolean>; onRollback: () => Promise<boolean> }) {
  const [overriding, setOverriding] = useState(false); const [reason, setReason] = useState(''); const [confirmRollback, setConfirmRollback] = useState(false);
  const paused = v.status !== 'active';
  const blocked = v.stage !== 'candidate' ? '' : paused ? 'Resume this version before promoting it.' : !v.gate ? 'Release gate unavailable.' : !v.gate.passed ? `${v.gate.checks.filter(c => !c.ok).length} release check${v.gate.checks.filter(c => !c.ok).length === 1 ? '' : 's'} failing.` : '';
  const reasonLength = reason.trim().length;
  return <li className={`release-version stage-${v.stage}`}>
    <header>
      <div><strong>v{v.version}</strong><StageBadge stage={v.stage} />{paused && <StatusBadge tone="warning">Paused</StatusBadge>}{current && <span className="release-current">This version</span>}</div>
      <small>{new Date(v.createdAt).toLocaleString()} · {v.environmentName} · {v.provider} · {v.model} · design r{v.revision}</small>
    </header>
    {v.promotion && <p className="release-promotion">{v.promotion.rollback ? 'Restored by rollback' : 'Promoted'} {new Date(v.promotion.at).toLocaleString()}{v.promotion.previousVersion ? ` · replaced v${v.promotion.previousVersion}` : ''}{v.promotion.passRate !== undefined ? ` · pass rate ${percent(v.promotion.passRate)}` : ''}{v.promotion.override && <span className="release-override-note"> · Override: “{v.promotion.override}”</span>}</p>}
    {v.stage === 'candidate' && v.gate && <GateChecklist gate={v.gate} />}
    <div className="arch-actions">
      {v.stage === 'candidate' && <><button className="btn btn-go btn-small" disabled={busy || !!blocked} aria-describedby={blocked ? `release-block-${v.id}` : undefined} onClick={() => { void onPromote(); }}><Icon name="arrow" size={14} />Promote to production</button>
        {!paused && v.gate && !v.gate.passed && <button className="btn btn-small" aria-expanded={overriding} disabled={busy} onClick={() => setOverriding(o => !o)}>Override…</button>}
        {blocked && <small id={`release-block-${v.id}`} className="release-blocked">{blocked}</small>}</>}
      {v.stage === 'retired' && !confirmRollback && <button className="btn btn-small" disabled={busy} onClick={() => setConfirmRollback(true)}><Icon name="undo" size={14} />Roll back to v{v.version}</button>}
      {onOpen && !current && <button className="btn btn-small btn-ghost" onClick={() => onOpen(v.id)}>Open version</button>}
    </div>
    {confirmRollback && <div className="release-confirm" role="group" aria-label={`Confirm rollback to v${v.version}`}><p>Triggers and webhooks that follow production switch to v{v.version} immediately. The current production version becomes retired. This skips the release gate and is audited.</p><div className="arch-actions"><button className="btn btn-small btn-go" disabled={busy} onClick={() => { void onRollback().then(ok => { if (ok) setConfirmRollback(false); }); }}>Roll back now</button><button className="btn btn-small" onClick={() => setConfirmRollback(false)}>Cancel</button></div></div>}
    {overriding && <form className="release-override" onSubmit={e => { e.preventDefault(); if (reasonLength >= OVERRIDE_MIN) void onPromote(reason.trim()).then(ok => { if (ok) { setOverriding(false); setReason(''); } }); }}>
      <label>Override reason · audited<textarea className="text-input" rows={2} maxLength={OVERRIDE_MAX} required value={reason} onChange={e => setReason(e.target.value)} placeholder="Why this version should serve production despite the failing checks" /></label>
      <p className="platform-help">The reason is stored with the promotion and written to the audit log. Failing checks stay recorded on this version. {reasonLength < OVERRIDE_MIN ? `${OVERRIDE_MIN - reasonLength} more character${OVERRIDE_MIN - reasonLength === 1 ? '' : 's'} needed.` : ''}</p>
      <div className="arch-actions"><button className="btn btn-small" disabled={busy || reasonLength < OVERRIDE_MIN}>Promote with audited override</button><button type="button" className="btn btn-small btn-ghost" onClick={() => { setOverriding(false); setReason(''); }}>Cancel</button></div>
    </form>}
  </li>;
}

export function GateChecklist({ gate }: { gate: ReleaseGate }) {
  return <div className="release-gate">
    <h4>{gate.passed ? 'Release gate passed' : 'Release gate not passed'}</h4>
    <ul aria-label={`Release checks for v${gate.version}`}>{gate.checks.map(c => <li key={c.label} className={c.ok ? 'is-ok' : 'is-failing'}>
      <span className="release-check-mark" aria-hidden="true"><Icon name={c.ok ? 'check' : 'close'} size={13} /></span>
      <div><strong>{c.label}<span className="arch-sr-only">{c.ok ? ': passed' : ': failing'}</span></strong><p>{c.detail}</p></div>
    </li>)}</ul>
    {!!gate.regressions.length && <p className="release-regressions">Regressed examples: {gate.regressions.slice(0, 12).map(id => <code key={id}>{id.slice(0, 8)}</code>)}{gate.regressions.length > 12 && ` and ${gate.regressions.length - 12} more`}</p>}
  </div>;
}

interface EvaluationLists { datasets: AgentDataset[]; evaluators: AgentEvaluator[] }

function ReleasePolicyEditor({ base, project, policy, onSaved }: { base: string; project: string; policy?: ReleasePolicy; onSaved: () => void }) {
  const [lists, setLists] = useState<EvaluationLists>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [open, setOpen] = useState(!policy);
  const [datasetId, setDatasetId] = useState(policy?.datasetId ?? ''); const [evaluatorIds, setEvaluatorIds] = useState<string[]>(policy?.evaluatorIds ?? []);
  const [minPass, setMinPass] = useState(policy ? Math.round(policy.minPassRate * 100) : DEFAULT_MIN_PASS_PERCENT);
  const [requireLive, setRequireLive] = useState(policy?.requireLiveTools ?? true); const [blockRegressions, setBlockRegressions] = useState(policy?.blockRegressions ?? true);
  useEffect(() => {
    if (!open || !project) return;
    let active = true;
    void request<EvaluationLists>('GET', `/api/agent-evaluation?project=${enc(project)}`).then(next => { if (active) setLists(next); }, e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [open, project]);
  const save = async () => {
    setBusy(true); setError('');
    try { await request('POST', `${base}/release-policy`, { datasetId, evaluatorIds, minPassRate: minPass / 100, requireLiveTools: requireLive, blockRegressions }); onSaved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const datasetName = lists?.datasets.find(d => d.id === policy?.datasetId)?.name;
  return <section className="release-policy" aria-label="Release policy">
    <header><div><h3>Release policy</h3><p className="platform-help">{policy ? `Pass rate ≥ ${percent(policy.minPassRate)} on ${datasetName ?? 'the selected dataset'} with ${policy.evaluatorIds.length} evaluator${policy.evaluatorIds.length === 1 ? '' : 's'}${policy.requireLiveTools ? ', tools live' : ''}${policy.blockRegressions ? ', no regressions vs production' : ''}.` : 'No policy yet. Without one, every candidate needs a written override to reach production.'}</p></div>
      <button className="btn btn-small" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Close policy' : policy ? 'Edit policy' : 'Set policy'}</button></header>
    {open && (!lists ? <p role="status">{error || 'Loading datasets and evaluators…'}</p> : !lists.datasets.length || !lists.evaluators.length
      ? <p className="agent-run-notice">Create a dataset and at least one evaluator in Evaluation, then return here to require them.</p>
      : <form className="platform-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>Dataset<select className="text-input" required value={datasetId} onChange={e => setDatasetId(e.target.value)}><option value="">Choose a dataset</option>{lists.datasets.map(d => <option key={d.id} value={d.id}>{d.name} · r{d.revision} · {d.examples.length} examples</option>)}</select></label>
        <label>Minimum pass rate (%)<input className="text-input" type="number" min={0} max={100} step={1} required value={minPass} onChange={e => setMinPass(Number(e.target.value))} /><small>Share of cases where every evaluator passed. Failed runs count as not passed.</small></label>
        <fieldset className="evaluation-checks platform-wide"><legend>Evaluators the candidate must pass (1–10)</legend>{lists.evaluators.map(ev => <label key={ev.id}><input type="checkbox" checked={evaluatorIds.includes(ev.id)} disabled={!evaluatorIds.includes(ev.id) && evaluatorIds.length >= 10} onChange={e => setEvaluatorIds(ids => e.target.checked ? [...ids, ev.id] : ids.filter(id => id !== ev.id))} />{ev.name} · v{ev.version}</label>)}</fieldset>
        <label className="platform-check platform-wide"><input type="checkbox" checked={requireLive} onChange={e => setRequireLive(e.target.checked)} />Require live tools · only experiments that ran the real tools count as evidence</label>
        <label className="platform-check platform-wide"><input type="checkbox" checked={blockRegressions} onChange={e => setBlockRegressions(e.target.checked)} />Block regressions · fail if an example that passed on production now fails</label>
        {error && <p className="arch-error platform-wide" role="alert">{error}</p>}
        <div className="arch-actions platform-wide"><button className="btn btn-go" disabled={busy || !datasetId || !evaluatorIds.length}>{busy ? 'Saving…' : 'Save release policy'}</button></div>
      </form>)}
  </section>;
}
