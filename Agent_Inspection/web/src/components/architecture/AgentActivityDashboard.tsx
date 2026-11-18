import { useCallback, useEffect, useState } from 'react';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { METRICS_RANGES, METRICS_SOURCES, type MetricsRange, type RunMetrics, type RunTotals } from '../../../../shared/agentRunMetrics.ts';
import { ChartCard, Legend, RankedBars, Sparkline, TimeColumns, TimeLines, TimeTable, bucketRange, type ChartSeries, type RankedRow } from './ActivityCharts.tsx';
import './activity-dashboard.css';

/** What a chart element hands to the run list when it drills in. */
export interface RunDrill { label: string; project: string; status?: 'succeeded' | 'failed' | 'cancelled' | 'other'; agentKey?: string; source?: string; model?: string; from?: number; to?: number }

const RANGE_KEY = 'waystation-activity-range';
const POLL_MS = 30_000;
const SOURCE_LABEL: Record<string, string> = { chat: 'Chat', api: 'API', interval: 'Schedule', webhook: 'Webhook', experiment: 'Experiment' };
const STATUS_SERIES = [
  { key: 'succeeded', label: 'Succeeded', color: 'var(--viz-ok)' },
  { key: 'failed', label: 'Failed', color: 'var(--viz-fail)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--viz-cancel)' },
  { key: 'other', label: 'Interrupted or active', color: 'var(--viz-other)' },
] as const;

const savedRange = (): MetricsRange => { try { const v = localStorage.getItem(RANGE_KEY); return v && v in METRICS_RANGES ? v as MetricsRange : '24h'; } catch { return '24h'; } };
const saveRange = (v: MetricsRange) => { try { localStorage.setItem(RANGE_KEY, v); } catch { /* storage unavailable: the choice lasts for this view only */ } };

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const fmtCount = (n: number) => Math.abs(n) >= 10_000 ? compact.format(n) : Math.round(n).toLocaleString();
export const fmtMs = (n: number | null) => n === null ? '—' : n < 1000 ? `${Math.round(n)} ms` : n < 60_000 ? `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s` : `${(n / 60_000).toFixed(1)} min`;
const fmtAxisMs = (n: number) => n === 0 ? '0' : fmtMs(n);
export const fmtUsd = (n: number) => n === 0 ? '$0' : n < 0.01 ? '<$0.01' : n < 1000 ? `$${n.toFixed(2)}` : `$${compact.format(n)}`;
const fmtAxisUsd = (n: number) => n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(1)}` : fmtUsd(n);
const fmtPct = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

type Better = 'up' | 'down' | 'neither';
interface Delta { text: string; tone: 'good' | 'bad' | 'neutral' }
/** Rates compare in percentage points, counts in relative change; colour follows whether the move is good, not its sign. */
function delta(current: number | null, previous: number | null, kind: 'rate' | 'count', better: Better): Delta {
  if (current === null || previous === null) return { text: 'No comparison', tone: 'neutral' };
  const diff = current - previous;
  if (Math.abs(diff) < 1e-9) return { text: 'No change', tone: 'neutral' };
  if (kind === 'count' && previous === 0) return { text: 'New this period', tone: 'neutral' };
  const text = kind === 'rate' ? `${diff > 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(1)} pts` : `${diff > 0 ? '+' : '−'}${Math.abs((diff / previous) * 100).toFixed(0)}%`;
  const tone = better === 'neither' ? 'neutral' : (diff > 0) === (better === 'up') ? 'good' : 'bad';
  return { text, tone };
}

function StatTile({ label, value, detail, change, period, trend }: { label: string; value: string; detail?: string; change: Delta; period: string; trend?: number[] }) {
  const arrow = change.text.startsWith('+') ? '↑' : change.text.startsWith('−') ? '↓' : '';
  return <div className="viz-tile">
    <span className="viz-tile-label">{label}</span>
    <strong className="viz-tile-value">{value}</strong>
    <span className={`viz-delta tone-${change.tone}`}>{arrow && <span aria-hidden="true">{arrow} </span>}{change.text}{arrow && <span className="viz-delta-period"> vs previous {period}</span>}</span>
    {detail && <small>{detail}</small>}
    {trend && <Sparkline values={trend} />}
  </div>;
}

function Kpis({ m, period }: { m: RunMetrics; period: string }) {
  const t: RunTotals = m.totals; const p = m.previous; const ts = m.timeseries;
  const finished = t.succeeded + t.failed + t.cancelled + t.interrupted;
  return <div className="viz-kpis" role="group" aria-label="Key metrics">
    <StatTile label="Runs" value={fmtCount(t.runs)} detail={t.active ? `${t.active} active now` : undefined} change={delta(t.runs, p.runs, 'count', 'neither')} period={period} trend={ts.map(b => b.succeeded + b.failed + b.cancelled + b.other)} />
    <StatTile label="Success rate" value={fmtPct(t.successRate)} detail={finished ? `${fmtCount(t.succeeded)} of ${fmtCount(finished)} finished` : 'No finished runs'} change={delta(t.successRate, p.successRate, 'rate', 'up')} period={period} />
    <StatTile label="p95 latency" value={fmtMs(t.p95Ms)} detail={t.p50Ms !== null ? `p50 ${fmtMs(t.p50Ms)} · p99 ${fmtMs(t.p99Ms)}` : undefined} change={delta(t.p95Ms, p.p95Ms, 'count', 'down')} period={period} />
    <StatTile label="Estimated cost" value={fmtUsd(t.estimatedCostUsd)} detail={t.unpricedRuns ? `${t.unpricedRuns} unpriced ${t.unpricedRuns === 1 ? 'run' : 'runs'} excluded` : 'List prices'} change={delta(t.estimatedCostUsd, p.estimatedCostUsd, 'count', 'down')} period={period} trend={ts.map(b => b.estimatedCostUsd)} />
    <StatTile label="Tokens" value={fmtCount(t.inputTokens + t.outputTokens)} detail={`${fmtCount(t.inputTokens)} in · ${fmtCount(t.outputTokens)} out`} change={delta(t.inputTokens + t.outputTokens, p.inputTokens + p.outputTokens, 'count', 'neither')} period={period} trend={ts.map(b => b.inputTokens + b.outputTokens)} />
    <StatTile label="Tool error rate" value={fmtPct(t.toolErrorRate)} detail={t.recordedToolCalls ? `${fmtCount(t.toolErrors)} of ${fmtCount(t.recordedToolCalls)} recorded calls` : 'No recorded tool calls'} change={delta(t.toolErrorRate, p.toolErrorRate, 'rate', 'down')} period={period} />
  </div>;
}

function Skeleton() {
  return <div className="viz-skeleton" role="status" aria-label="Loading metrics"><div className="viz-kpis">{Array.from({ length: 6 }, (_, i) => <div key={i} className="viz-tile viz-shimmer" />)}</div><div className="viz-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="viz-card viz-shimmer viz-shimmer-chart" />)}</div></div>;
}

interface DashboardProps { project: string; onProject?: (project: string) => void; onDrill: (drill: RunDrill) => void; onOpenRun: (id: string) => void }

export function AgentActivityDashboard({ project, onProject, onDrill, onOpenRun }: DashboardProps) {
  const [range, setRange] = useState<MetricsRange>(savedRange); const [agent, setAgent] = useState(''); const [source, setSource] = useState('');
  const [data, setData] = useState<RunMetrics>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [folder, setFolder] = useState(project);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!project) return;
    setLoading(true);
    const q = new URLSearchParams({ project, range, tz: String(new Date().getTimezoneOffset()) }); if (agent) q.set('agent', agent); if (source) q.set('source', source);
    try { const next = await request<RunMetrics>('GET', `/api/agent-runs/metrics?${q}`, undefined, signal); setData(next); setError(''); }
    catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [project, range, agent, source]);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(controller.signal); }, POLL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  useEffect(() => { setFolder(project); setData(undefined); setAgent(''); }, [project]);
  const period = range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days';
  const drill = (extra: Omit<RunDrill, 'project' | 'label'> & { label: string }) => {
    const agentRow = data?.agents.find(a => a.key === agent);
    const scope = [agentRow?.agentName, source && SOURCE_LABEL[source]].filter(Boolean).join(' · ');
    onDrill({ project, agentKey: agent || undefined, source: source || undefined, from: data?.from, to: data?.to, ...extra, label: scope ? `${extra.label} · ${scope}` : extra.label });
  };

  const projectForm = onProject && <form className="viz-project" onSubmit={e => { e.preventDefault(); if (folder.trim()) onProject(folder.trim()); }}><label>Project<input className="text-input" value={folder} onChange={e => setFolder(e.target.value)} required placeholder="Absolute project folder" /></label><button className="btn btn-small">Use project</button></form>;
  if (!project) return <section className="activity-dash" aria-label="Agent activity overview">{projectForm}<p className="agent-run-notice">Choose a project to see its agent metrics.</p></section>;

  return <section className="activity-dash" aria-label="Agent activity overview" aria-busy={loading}>
    <div className="viz-filters">
      <div className="viz-range" role="group" aria-label="Time range">{(Object.keys(METRICS_RANGES) as MetricsRange[]).map(r => <button key={r} type="button" aria-pressed={range === r} className={range === r ? 'selected' : ''} onClick={() => { setRange(r); saveRange(r); }}>{r}</button>)}</div>
      <label>Agent<select className="text-input" value={agent} onChange={e => setAgent(e.target.value)}><option value="">All agents</option>{data?.agents.map(a => <option key={a.key} value={a.key}>{a.agentName} · {a.architectureTitle}</option>)}</select></label>
      <label>Source<select className="text-input" value={source} onChange={e => setSource(e.target.value)}><option value="">All sources</option>{METRICS_SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></label>
      <button type="button" className="btn btn-small" disabled={loading} onClick={() => { void load(); }}><Icon name="refresh" size={14} />Refresh</button>
      {data && <span className="viz-updated">Updated {new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
      {projectForm}
    </div>
    {error && <div className="arch-error viz-error" role="alert"><span>Metrics could not load: {error}</span><button type="button" className="btn btn-small" onClick={() => { void load(); }}>Retry</button></div>}
    {!data ? (error ? null : <Skeleton />) : !data.totals.runs ? <div className="viz-empty"><h4>No runs in this range yet</h4><p>Run an agent or start an experiment, and its runs, cost and failures will chart here.</p></div>
      : <div className={loading ? 'viz-body is-refreshing' : 'viz-body'}><Kpis m={data} period={period} /><Charts m={data} drill={drill} onOpenRun={onOpenRun} /></div>}
  </section>;
}

type Drill = (extra: Omit<RunDrill, 'project' | 'label'> & { label: string }) => void;

function Charts({ m, drill, onOpenRun }: { m: RunMetrics; drill: Drill; onOpenRun: (id: string) => void }) {
  const ts = m.timeseries; const starts = ts.map(b => b.start);
  const statusSeries: ChartSeries[] = STATUS_SERIES.map(s => ({ ...s, values: ts.map(b => b[s.key]) }));
  const latency: ChartSeries[] = [{ key: 'p95', label: 'p95', color: 'var(--viz-1)', values: ts.map(b => b.p95Ms) }, { key: 'p50', label: 'p50', color: 'var(--viz-2)', values: ts.map(b => b.p50Ms) }];
  const cost: ChartSeries[] = [{ key: 'cost', label: 'Estimated cost', color: 'var(--viz-1)', values: ts.map(b => b.estimatedCostUsd) }];
  const tokens: ChartSeries[] = [{ key: 'in', label: 'Input', color: 'var(--viz-1)', values: ts.map(b => b.inputTokens) }, { key: 'out', label: 'Output', color: 'var(--viz-2)', values: ts.map(b => b.outputTokens) }];
  const tools: ChartSeries[] = [{ key: 'ok', label: 'Calls without error', color: 'var(--viz-1)', values: ts.map(b => Math.max(0, b.toolCalls - b.toolErrors)) }, { key: 'err', label: 'Errors', color: 'var(--viz-fail)', values: ts.map(b => b.toolErrors) }];
  const pickBucket = (i: number, key?: string) => {
    const status = STATUS_SERIES.find(s => s.key === key);
    drill({ label: `${status ? status.label : 'Runs'} · ${bucketRange(starts[i], m.bucketMs)}`, status: status?.key, from: starts[i], to: starts[i] + m.bucketMs });
  };
  const unpriced = m.totals.unpricedRuns;
  const table = (series: ChartSeries[], format: (v: number) => string, caption: string) => <TimeTable starts={starts} bucketMs={m.bucketMs} series={series} format={format} caption={caption} />;
  return <>
    <div className="viz-grid">
      <ChartCard wide title="Runs over time" subtitle="Runs started per period, by outcome. Select a segment to list those runs." legend={<Legend items={[...STATUS_SERIES]} />} table={table(statusSeries, fmtCount, 'Runs per period by outcome')}>
        <TimeColumns starts={starts} bucketMs={m.bucketMs} series={statusSeries} format={fmtCount} label="Runs over time by outcome" onSelect={pickBucket} />
      </ChartCard>
      <ChartCard title="Latency" subtitle="Wall time of finished runs, per period" legend={<Legend items={latency.map(s => ({ label: s.label, color: s.color, kind: 'line' }))} />} table={table(latency, v => fmtMs(v), 'Latency percentiles per period')}>
        <TimeLines starts={starts} bucketMs={m.bucketMs} series={latency} format={fmtAxisMs} label="p50 and p95 latency over time" />
      </ChartCard>
      <ChartCard title="Estimated cost" subtitle="USD at list prices, input and output tokens" table={table(cost, fmtUsd, 'Estimated cost per period')}
        note={unpriced ? `${unpriced} ${unpriced === 1 ? 'run uses a model' : 'runs use models'} without a price table and ${unpriced === 1 ? 'is' : 'are'} excluded. Cache pricing is not applied.` : 'Estimate from list prices; cache pricing is not applied.'}>
        <TimeColumns starts={starts} bucketMs={m.bucketMs} series={cost} format={fmtAxisUsd} label="Estimated cost over time" />
      </ChartCard>
      <ChartCard title="Tokens" subtitle="Input and output tokens per period" legend={<Legend items={tokens} />} table={table(tokens, fmtCount, 'Tokens per period')}>
        <TimeColumns starts={starts} bucketMs={m.bucketMs} series={tokens} format={fmtCount} label="Input and output tokens over time" />
      </ChartCard>
      <ChartCard title="Tool calls & errors" subtitle="Calls counted per period; errors from recorded calls" legend={<Legend items={tools} />} table={table(tools, fmtCount, 'Tool calls and errors per period')}>
        <TimeColumns starts={starts} bucketMs={m.bucketMs} series={tools} format={fmtCount} label="Tool calls and errors over time" />
      </ChartCard>
    </div>
    <div className="viz-grid">
      <Breakdowns m={m} drill={drill} />
      <RecentFailures m={m} onOpenRun={onOpenRun} drill={drill} />
    </div>
  </>;
}

const TOP_ROWS = 8;

/** One ranked list: the card shows the top rows with drill links, the table view lists every row. */
function Ranked({ title, subtitle, caption, columns, rows, empty }: { title: string; subtitle: string; caption: string; columns: string[]; rows: RankedRow[]; empty?: string }) {
  const all = rows.map(({ onSelect: _, ...row }) => row);
  return <ChartCard title={title} subtitle={subtitle} table={<RankedBars caption={caption} color="var(--viz-1)" columns={columns} rows={all} />}>
    {rows.length || !empty ? <RankedBars caption={caption} color="var(--viz-1)" columns={columns} rows={rows.slice(0, TOP_ROWS)} /> : <p className="viz-none">{empty}</p>}
  </ChartCard>;
}

function Breakdowns({ m, drill }: { m: RunMetrics; drill: Drill }) {
  const agents: RankedRow[] = m.byAgent.map(a => ({ key: a.key, label: a.agentName, detail: a.architectureTitle, value: a.runs, display: fmtCount(a.runs),
    cells: [fmtPct(a.successRate), fmtMs(a.p95Ms), a.unpricedRuns === a.runs ? 'No price' : fmtUsd(a.estimatedCostUsd)], onSelect: () => drill({ label: a.agentName, agentKey: a.key }) }));
  const models: RankedRow[] = m.byModel.map(r => ({ key: `${r.provider}:${r.model}`, label: r.model || 'Unknown model', detail: r.provider, value: r.runs, display: fmtCount(r.runs),
    cells: [fmtPct(r.successRate), fmtCount(r.inputTokens + r.outputTokens), r.estimatedCostUsd === null ? 'No price' : fmtUsd(r.estimatedCostUsd)], onSelect: () => drill({ label: r.model || 'Unknown model', model: r.model }) }));
  const sources: RankedRow[] = m.bySource.map(s => ({ key: s.source, label: SOURCE_LABEL[s.source] ?? s.source, value: s.runs, display: fmtCount(s.runs),
    cells: [fmtCount(s.failed), fmtPct(s.successRate)], onSelect: () => drill({ label: SOURCE_LABEL[s.source] ?? s.source, source: s.source }) }));
  const tools: RankedRow[] = m.byTool.map(t => ({ key: `${t.source}:${t.name}`, label: t.name, detail: t.source, value: t.calls, display: fmtCount(t.calls),
    cells: [`${fmtCount(t.errors)} · ${fmtPct(t.errorRate)}`, fmtMs(t.avgDurationMs), fmtCount(t.operatorApprovals)] }));
  return <>
    <Ranked title="By agent" subtitle="Ranked by runs. Select an agent to list its runs." caption="Runs by agent" columns={['Agent', 'Runs', 'Success', 'p95', 'Est. cost']} rows={agents} />
    <Ranked title="By model" subtitle="Ranked by runs" caption="Runs by model" columns={['Model', 'Runs', 'Success', 'Tokens', 'Est. cost']} rows={models} />
    <Ranked title="By source" subtitle="Where runs were started" caption="Runs by source" columns={['Source', 'Runs', 'Failed', 'Success']} rows={sources} />
    <Ranked title="By tool" subtitle="Recorded calls, ranked by volume" caption="Tool calls by tool" columns={['Tool', 'Calls', 'Errors', 'Avg time', 'Approved by you']} rows={tools} empty="No recorded tool calls in this range." />
  </>;
}

function RecentFailures({ m, onOpenRun, drill }: { m: RunMetrics; onOpenRun: (id: string) => void; drill: Drill }) {
  return <section className="viz-card viz-card-wide viz-failures" aria-labelledby="viz-failures-title">
    <header><div><h4 id="viz-failures-title">Recent failures</h4><p>The latest failed runs in this range. Open one to see its trace.</p></div>{m.totals.failed > 0 && <button type="button" className="viz-table-toggle" onClick={() => drill({ label: 'Failed runs', status: 'failed' })}>All {fmtCount(m.totals.failed)} failed</button>}</header>
    {!m.recentFailures.length ? <p className="viz-none"><Icon name="check" size={14} />No failed runs in this range.</p>
      : <ol>{m.recentFailures.map(f => <li key={f.id}><button type="button" onClick={() => onOpenRun(f.id)}>
        <span className="viz-fail-mark" aria-hidden="true"><Icon name="alert" size={13} /></span>
        <span className="viz-fail-main"><strong>{f.agentName}</strong><span className="viz-fail-error">{f.error || 'Failed without an error message'}</span></span>
        <time dateTime={new Date(f.finishedAt).toISOString()}>{new Date(f.finishedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      </button></li>)}</ol>}
  </section>;
}
