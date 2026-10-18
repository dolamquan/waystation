import type { Agent } from '../api.ts';
import { BREAKER_LABEL, contextPercent, formatTokens, formatUsd, shortModel } from '../format.ts';

const CONTEXT_WARN_PERCENT = 70;
const CONTEXT_FULL_PERCENT = 90;

const totalTokens = (agent: Agent): number => {
  const t = agent.usage?.tokens;
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h : 0;
};

/** Model, spend and how full the context window is. Renders nothing until something is known. */
export function AgentMeta({ agent }: { readonly agent: Agent }) {
  const model = shortModel(agent.model);
  const usage = agent.usage;
  const percent = contextPercent(agent);
  if (!model && !usage) return null;
  const tokens = totalTokens(agent);
  const level = percent === undefined ? '' : percent >= CONTEXT_FULL_PERCENT ? 'gauge-full' : percent >= CONTEXT_WARN_PERCENT ? 'gauge-warn' : '';
  return (
    <div className="agent-meta">
      {model && <span className="meta-chip" title={agent.model}>{model}</span>}
      {usage && (
        <span className="meta-spend" title={`${tokens.toLocaleString()} tokens${usage.costUsd === undefined ? ' (no list price known for this model)' : ' (list-price estimate)'}`}>
          {usage.costUsd !== undefined ? formatUsd(usage.costUsd) : `${formatTokens(tokens)} tok`}
        </span>
      )}
      {percent !== undefined && (
        <span
          className={`meta-gauge ${level}`}
          role="meter"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          title={`Context: ${formatTokens(usage?.contextTokens ?? 0)} of ${formatTokens(usage?.contextWindow ?? 0)} tokens`}
        >
          <span className="meta-gauge-fill" style={{ width: `${percent}%` }} />
          <span className="meta-gauge-label">{percent}% context</span>
        </span>
      )}
    </div>
  );
}

/** A visible strip instead of a silent agent: the runaway guard stepped in, or the last turn failed. */
export function AgentAlert({ agent }: { readonly agent: Agent }) {
  if (agent.breaker && agent.breaker.level !== 'ok') {
    return <div className={`agent-alert alert-guard alert-${agent.breaker.level}`} title={agent.breaker.reason}><strong>{BREAKER_LABEL[agent.breaker.level]}</strong> {agent.breaker.reason}</div>;
  }
  if (agent.lastError) {
    return <div className="agent-alert alert-error" title={agent.lastError}><strong>{agent.status === 'stopped' ? 'Crashed' : 'Last turn failed'}</strong> {agent.lastError}</div>;
  }
  return null;
}
