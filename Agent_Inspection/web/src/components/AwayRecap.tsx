import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { Agent, PendingInterception } from '../api.ts';
import { formatUsd, timeAgo } from '../format.ts';
import { RECAP_MIN_AWAY_MS, buildRecap, readLastVisit, shouldShowRecap, writeLastVisit, type RecapEntry, type RecapGroup } from '../recap.ts';
import { Icon } from './Icon.tsx';
import '../recap.css';

const MAX_PER_GROUP = 4;

interface AwayRecapProps {
  readonly agents: readonly Agent[];
  readonly pending: readonly PendingInterception[];
  readonly now: number;
  readonly onSelect: (id: string) => void;
}

const GROUPS: readonly { readonly key: RecapGroup; readonly title: string; readonly icon: 'alert' | 'info' | 'check' }[] = [
  { key: 'waiting', title: 'Waiting on you', icon: 'alert' },
  { key: 'trouble', title: 'Hit trouble', icon: 'info' },
  { key: 'finished', title: 'Finished or idle', icon: 'check' },
];

/** When the operator last left (`since`) and when they came back (`arrivedAt`); a first-ever visit has no `since`. */
interface Visit {
  readonly since?: number;
  readonly arrivedAt: number;
}

function arrive(): Visit {
  const arrivedAt = Date.now();
  const since = readLastVisit();
  if (since === undefined) writeLastVisit(arrivedAt);
  return { since, arrivedAt };
}

/**
 * The away time is fixed on arrival, never derived from the ticking clock, so the card cannot pop up
 * while someone is watching the page. Coming back to a tab hidden for a while starts a fresh visit.
 */
function useVisit(): Visit {
  const [visit, setVisit] = useState<Visit>(arrive);
  useEffect(() => {
    const record = (): void => { writeLastVisit(Date.now()); };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') { record(); return; }
      const fresh = arrive();
      if (fresh.since !== undefined && fresh.arrivedAt - fresh.since >= RECAP_MIN_AWAY_MS) setVisit(fresh);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', record);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', record);
    };
  }, []);
  return visit;
}

function RecapLine({ entry, now, onSelect }: { readonly entry: RecapEntry; readonly now: number; readonly onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`recap-line recap-${entry.group}`} onClick={() => onSelect(entry.id)} title={`Open ${entry.name}`}>
        <span className="recap-dot" aria-hidden="true" />
        <span className="recap-who"><strong>{entry.name}</strong><small>{entry.project}</small></span>
        <span className="recap-detail">{entry.detail}</span>
        <span className="recap-time">{timeAgo(entry.at, now)}</span>
      </button>
    </li>
  );
}

export function AwayRecap({ agents, pending, now, onSelect }: AwayRecapProps) {
  const { since, arrivedAt } = useVisit();
  const [dismissedAt, setDismissedAt] = useState<number | undefined>();
  // Away time is measured up to arrival; entries still reflect each agent's current state.
  const recap = useMemo(() => (since === undefined ? undefined : buildRecap(agents, pending, since, arrivedAt)), [agents, pending, since, arrivedAt]);
  const visible = dismissedAt !== arrivedAt && recap !== undefined && shouldShowRecap(recap);

  const dismiss = (): void => {
    writeLastVisit(Date.now());
    setDismissedAt(arrivedAt);
  };

  return (
    <AnimatePresence initial={false}>
      {visible && recap && (
        <motion.section
          key="away-recap"
          className="away-recap"
          aria-label="While you were away"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          <header className="recap-head">
            <div>
              <div className="eyebrow">WHILE YOU WERE AWAY<span className="heading-dot">.</span></div>
              <h2>Welcome back — here’s what your crew did</h2>
              <p className="muted small">
                Since your last visit {timeAgo(recap.since, now)}: {recap.activeCount} agent{recap.activeCount === 1 ? '' : 's'} active
                {recap.stillWorking > 0 && `, ${recap.stillWorking} still working`}
                {recap.hasCost && <> · <span className="recap-cost" title="Whole-session list-price estimate for the sessions active while you were away; some agents have no known price">~{formatUsd(recap.spentUsd)} across these sessions (est.)</span></>}
              </p>
            </div>
            <button type="button" className="icon-btn" onClick={dismiss} aria-label="Dismiss recap" title="Got it"><Icon name="close" size={16} /></button>
          </header>
          <div className="recap-groups">
            {GROUPS.map(({ key, title, icon }) => {
              const entries = recap[key];
              if (entries.length === 0) return null;
              const extra = entries.length - MAX_PER_GROUP;
              return (
                <div key={key} className={`recap-group recap-group-${key}`}>
                  <div className="recap-group-title"><Icon name={icon} size={14} />{title}<span className="section-count">{entries.length}</span></div>
                  <ul>
                    {entries.slice(0, MAX_PER_GROUP).map(entry => <RecapLine key={entry.id} entry={entry} now={now} onSelect={onSelect} />)}
                  </ul>
                  {extra > 0 && <div className="recap-more muted small">and {extra} more</div>}
                </div>
              );
            })}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
