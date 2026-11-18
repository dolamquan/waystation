import type { ExperimentCase, ExperimentStats } from '../../../../shared/agentEvaluation.ts';
import { StatusBadge } from './ArchitectureUI.tsx';

export const pct = (value: number) => `${Math.round(value * 100)}%`;
const ms = (value?: number) => value === undefined ? '—' : value >= 10000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value).toLocaleString()} ms`;
const TOOL_MODE_HINT = {
  live: 'Tools ran for real: this experiment tested the deployed agent, including external calls and their side effects.',
  disabled: 'Every tool was removed for this experiment, so it measured a text-only variant, not the deployed agent.',
} as const;

export function ToolModeBadge({ mode }: { mode: 'live' | 'disabled' }) {
  return <span title={TOOL_MODE_HINT[mode]} aria-label={`Tools ${mode}. ${TOOL_MODE_HINT[mode]}`}><StatusBadge tone={mode === 'live' ? 'neutral' : 'warning'}>Tools: {mode}</StatusBadge></span>;
}

/** Headline metrics for one experiment. Pass rate leads: it cannot be inflated by failed or unscored cases. */
export function ExperimentStatsPanel({ stats, repetitions }: { stats: ExperimentStats; repetitions: number }) {
  return <section className="eval-stats" aria-label="Experiment results">
    <div className="eval-stats-headline">
      <div className="eval-pass-rate"><span>Pass rate</span><strong>{pct(stats.passRate)}</strong><small>{stats.passed} of {stats.total} cases passed every evaluator{stats.errored ? ` · ${stats.errored} errored` : ''}{stats.finished < stats.total ? ` · ${stats.total - stats.finished} still running` : ''}</small></div>
      <dl className="eval-stats-facts">
        {repetitions > 1 && <><div><dt title="Share of examples where at least one repetition passed">pass@{repetitions}</dt><dd>{pct(stats.passAtK)}</dd></div><div><dt title="Share of examples where every repetition passed: the reliability measure">pass^{repetitions}</dt><dd>{pct(stats.passHatK)}</dd></div></>}
        <div><dt title="Average evaluator score; failed and unscored cases count as 0">Mean score</dt><dd>{stats.meanScore.toFixed(2)}<small>failures count as 0</small></dd></div>
        <div><dt>Latency p50 / p95</dt><dd>{ms(stats.p50Ms)} / {ms(stats.p95Ms)}</dd></div>
        <div><dt>Tokens</dt><dd>{stats.tokens.toLocaleString()}</dd></div>
      </dl>
    </div>
    {!!stats.perEvaluator.length && <table className="eval-per-evaluator"><caption>Per evaluator</caption><thead><tr><th scope="col">Evaluator</th><th scope="col">Pass rate</th><th scope="col">Mean</th></tr></thead>
      <tbody>{stats.perEvaluator.map(e => <tr key={e.evaluatorId}><td>{e.name}</td><td><span className="eval-bar" aria-hidden="true"><span style={{ width: pct(e.passRate) }} /></span>{pct(e.passRate)}</td><td>{e.meanScore.toFixed(2)}</td></tr>)}</tbody></table>}
  </section>;
}

export interface ComparisonSummary { baseline: ExperimentStats; candidate: ExperimentStats; passRateDelta: number; meanScoreDelta: number; regressions: string[]; fixes: string[] }

/** Baseline vs candidate at a glance: the pass-rate change and exactly which examples regressed or were fixed. */
export function ComparisonSummaryView({ summary, baselineName, candidateName, cases }: { summary: ComparisonSummary; baselineName: string; candidateName: string; cases: readonly Pick<ExperimentCase, 'exampleId' | 'input'>[] }) {
  const inputOf = (id: string) => cases.find(c => c.exampleId === id)?.input ?? '';
  const delta = Math.round(summary.passRateDelta * 100);
  const examples = (ids: string[], empty: string) => !ids.length ? <p className="platform-help">{empty}</p> : <ul>{ids.map(id => <li key={id}><code>{id.slice(0, 8)}</code><span>{inputOf(id).slice(0, 120)}</span></li>)}</ul>;
  return <section className="eval-compare-summary" aria-label="Comparison summary">
    <div className="eval-compare-rates">
      <div><span>{baselineName}</span><strong>{pct(summary.baseline.passRate)}</strong></div>
      <div className={delta > 0 ? 'evaluation-improved' : delta < 0 ? 'evaluation-regressed' : ''}><span>Change</span><strong>{delta > 0 ? '+' : ''}{delta} pts</strong></div>
      <div><span>{candidateName}</span><strong>{pct(summary.candidate.passRate)}</strong></div>
    </div>
    <div className="eval-compare-lists">
      <div><h3 className="evaluation-regressed">Regressions · {summary.regressions.length}</h3>{examples(summary.regressions, 'No example that passed on the baseline fails now.')}</div>
      <div><h3 className="evaluation-improved">Fixes · {summary.fixes.length}</h3>{examples(summary.fixes, 'No example that failed on the baseline passes on every repetition now.')}</div>
    </div>
  </section>;
}
