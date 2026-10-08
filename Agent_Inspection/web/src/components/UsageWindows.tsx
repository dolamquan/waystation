import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { formatTokens, formatUsd, timeAgo } from '../format.ts';
import type { ComputedWindow, PlanLimit, UsageWindowsReport, VendorWindows } from '../../../daemon/usage/windowTypes.ts';
import { Icon } from './Icon.tsx';

/** The daemon caches the report for a minute, so polling faster gains nothing. */
const POLL_MS = 60_000;
/** Re-render "resets in" text between polls. */
const TICK_MS = 30_000;
const WARN_PERCENT = 75;
const FULL_PERCENT = 90;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const VENDOR_NAME: Record<VendorWindows['vendor'], string> = { claude: 'Claude', codex: 'Codex' };
const SOURCE_TEXT: Record<PlanLimit['source'], string> = {
  codex: 'reported by Codex',
  'claude-sdk': 'reported by Claude',
  'claude-transcript': 'reported by Claude Code',
};

/** "2h 14m", "3d 4h", "12m", "under 1m". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'under 1m';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function resetText(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  return resetsAt <= now ? 'Window has reset since this reading' : `Resets in ${formatDuration(resetsAt - now)}`;
}

export function meterLevel(percent: number): 'ok' | 'warn' | 'full' {
  if (percent >= FULL_PERCENT) return 'full';
  return percent >= WARN_PERCENT ? 'warn' : 'ok';
}

const clock = (ts: number, withDay: boolean) => new Date(ts).toLocaleString(undefined, withDay
  ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
  : { hour: 'numeric', minute: '2-digit' });

const STATUS_TEXT: Record<NonNullable<PlanLimit['status']>, string> = {
  allowed: 'Within limit',
  allowed_warning: 'Approaching limit',
  rejected: 'Limit reached',
};

function LimitMeter({ limit, now }: { readonly limit: PlanLimit; readonly now: number }) {
  const expired = limit.resetsAt !== undefined && limit.resetsAt <= now;
  const percent = limit.usedPercent !== undefined && Number.isFinite(limit.usedPercent) ? Math.min(100, Math.max(0, limit.usedPercent)) : undefined;
  const value = percent !== undefined ? `${Math.round(percent)}%` : '—';
  const reset = resetText(limit.resetsAt, now);
  const level = limit.status === 'rejected' ? 'full' : limit.status === 'allowed_warning' ? 'warn' : percent === undefined ? 'ok' : meterLevel(percent);
  return <div className={`limit-meter limit-${expired ? 'expired' : level}`}>
    <div className="limit-meter-head"><strong>{limit.label} window</strong><span className="usage-percentage">{value}<small>{percent === undefined ? 'unavailable' : expired ? 'last reading' : 'used'}</small></span></div>
    {percent !== undefined
      ? <div className="limit-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={`${value} ${expired ? 'at the last reading, window has since reset' : 'used'}`} aria-label={`${limit.label} plan usage`}><span style={{ width: `${percent}%` }} /></div>
      : <div className="limit-track limit-track-unavailable" aria-hidden="true" />}
    <div className="usage-reset"><Icon name={expired ? 'refresh' : 'clock'} size={13} /><span>{reset ?? (limit.status ? STATUS_TEXT[limit.status] : 'Percentage not reported')}{limit.resetsAt && !expired ? ` · ${clock(limit.resetsAt, limit.resetsAt - now > DAY / 2)}` : ''}</span></div>
    <div className="usage-observed">Updated {timeAgo(limit.observedAt, now)} · {SOURCE_TEXT[limit.source]}{limit.status && !expired && (limit.status !== 'allowed' || percent === undefined) && <span className={`usage-limit-status status-${level}`}>{STATUS_TEXT[limit.status]}</span>}</div>
  </div>;
}

function MissingLimit({ label }: { readonly label: string }) {
  return <div className="limit-meter limit-missing"><div className="limit-meter-head"><strong>{label} window</strong><span className="usage-percentage">—<small>unavailable</small></span></div><div className="limit-track limit-track-unavailable" aria-hidden="true" /><div className="usage-reset"><Icon name="info" size={13} /><span>No percentage reading yet</span></div></div>;
}

function TokenBreakdown({ window }: { readonly window: ComputedWindow }) {
  const t = window.tokens;
  return <dl className="limit-breakdown">
    <div><dt>Input</dt><dd>{formatTokens(t.input)}</dd></div>
    <div><dt>Output</dt><dd>{formatTokens(t.output)}</dd></div>
    <div><dt>Cache read</dt><dd>{formatTokens(t.cacheRead)}</dd></div>
    <div><dt>Cache write</dt><dd>{formatTokens(t.cacheWrite5m + t.cacheWrite1h)}</dd></div>
  </dl>;
}

const costText = (window: ComputedWindow) => window.costUsd !== undefined
  ? `${formatUsd(window.costUsd)} est.${window.unpricedTokens > 0 ? ' (some tokens unpriced)' : ''}`
  : 'Tokens only, no price estimate';

function ComputedBlock({ title, window, note }: { readonly title: string; readonly window: ComputedWindow; readonly note: string }) {
  return <div className="limit-computed">
    <div className="limit-meter-head"><strong>{title}</strong><span>{formatTokens(window.totalTokens)} <small>tokens</small></span></div>
    <div className="usage-local-meta"><span>{costText(window)}</span><span>{window.requests} {window.requests === 1 ? 'request' : 'requests'}</span></div>
    <small>{note}</small>
    <TokenBreakdown window={window} />
  </div>;
}

function VendorCard({ vendor, now }: { readonly vendor: VendorWindows; readonly now: number }) {
  const name = VENDOR_NAME[vendor.vendor];
  const block = vendor.block;
  const defaults = [{ window: 'five_hour', label: '5-hour' }, { window: vendor.vendor === 'claude' ? 'seven_day' : 'weekly', label: 'Weekly' }];
  const otherLimits = vendor.limits.filter((limit) => !defaults.some((window) => window.window === limit.window));
  return <article className={`limit-vendor limit-vendor-${vendor.vendor}`} aria-labelledby={`limits-${vendor.vendor}`}>
    <header><span className="usage-vendor-icon"><Icon name={vendor.vendor === 'claude' ? 'sparkle' : 'terminal'} size={24} /></span><div><h3 id={`limits-${vendor.vendor}`}>{name}</h3><span>Subscription usage</span></div>{vendor.planType && <span className="usage-plan-badge">{vendor.planType} plan</span>}</header>
    <div className="limit-group usage-plan-windows" aria-label={`${name} plan percentages`}>
      <div className="usage-group-heading"><span>Plan limits</span><span className="usage-source-badge">Reported by {name}</span></div>
      {defaults.map((window) => {
        const limit = vendor.limits.find((reading) => reading.window === window.window);
        return limit ? <LimitMeter key={window.window} limit={limit} now={now} /> : <MissingLimit key={window.window} label={window.label} />;
      })}
      {otherLimits.map((limit) => <LimitMeter key={limit.window} limit={limit} now={now} />)}
      {vendor.limits.length === 0 && <p className="usage-no-reading">{vendor.vendor === 'claude' ? 'Claude hasn’t supplied a plan percentage yet. Refresh to check again.' : 'A percentage reading will appear after a Codex session reports its limits.'}</p>}
    </div>
    <details className="usage-local-details">
      <summary><span><Icon name="activity" size={15} />Local usage details<small>Tokens & estimated cost</small></span><Icon name="chevronDown" size={15} /></summary>
      <div className="limit-group">
        {block
          ? <ComputedBlock title="Current 5-hour block" window={block} note={`${resetText(block.end, now) ?? ''} (${clock(block.end, false)}), started ${clock(block.start, false)}`} />
          : <p className="limit-none">No active 5-hour block. The next request starts one.</p>}
        <ComputedBlock title="Last 7 days" window={vendor.week} note={vendor.week.lastActivityAt ? `Last activity ${timeAgo(vendor.week.lastActivityAt, now)}` : 'No local activity'} />
      </div>
    </details>
  </article>;
}

interface UsageWindowsProps {
  /** Bump to reload now (the page's Refresh button). */
  readonly refreshKey?: number;
}

export function UsageWindows({ refreshKey = 0 }: UsageWindowsProps) {
  const [report, setReport] = useState<UsageWindowsReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.usageWindows();
      setReport(result.windows);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load, refreshKey]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, []);

  return <section className="workspace-panel limit-panel usage-plan-panel" aria-labelledby="ops-limits" aria-busy={loading}>
    <div className="section-heading"><div><div className="usage-eyebrow"><Icon name="activity" size={14} />YOUR PLAN AT A GLANCE</div><h2 id="ops-limits">Plan usage</h2><p>See how much of each plan you’ve used, and when your limits reset.</p></div>{report && <span className="usage-updated"><Icon name="refresh" size={13} />{loading ? 'Updating…' : `Updated ${timeAgo(report.generatedAt, now)}`}</span>}</div>
    {error && <div className="detail-load-error" role="alert"><p>Couldn’t update plan usage. {error}</p><button className="btn" disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {!report && !error && <div className="workspace-loading" role="status"><Icon name="clock" />Reading plan usage…</div>}
    {report && <>
      <div className="limit-vendors">{report.vendors.map((vendor) => <VendorCard key={vendor.vendor} vendor={vendor} now={now} />)}</div>
      <div className="usage-measurement-note"><Icon name="info" size={16} /><div><p>Plan percentages are reported by Claude and Codex. Local token totals are shown in each card’s usage details.</p><details><summary>How usage is measured</summary><p>Token counts and costs are estimates from this machine’s sessions at list prices. Local 5-hour blocks start at the hour of your first request after the previous block ended. Local totals exclude other devices and web usage; plan percentages reflect the provider’s reported usage. A missing percentage stays unavailable rather than being estimated from tokens.</p></details></div></div>
    </>}
  </section>;
}
