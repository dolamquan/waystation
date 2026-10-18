import { useEffect, useRef, useState } from 'react';
import { api, type TeamLogEntry } from '../../api.ts';
import type { TeamLogItem } from '../../useTower.ts';
import { mergeEntries } from './teamLog.ts';

export interface TeamLogState {
  readonly log: readonly TeamLogEntry[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly reload: () => void;
}

/** The team's saved log, kept current with live entries from the tower feed. */
export function useTeamLog(teamId: string, feed: readonly TeamLogItem[], notify: (text: string, kind?: 'ok' | 'error') => void): TeamLogState {
  const [log, setLog] = useState<TeamLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    setLog([]);
    setLoading(true);
    setFailed(false);
    api.teamLog(teamId).then(
      (result) => {
        if (ignore) return;
        setLog((previous) => mergeEntries(result.entries, previous));
        setLoading(false);
      },
      (error: Error) => {
        if (ignore) return;
        setLoading(false);
        setFailed(true);
        notify(error.message, 'error');
      },
    );
    return () => { ignore = true; };
  }, [teamId, notify, attempt]);

  // Consume every feed item newer than the last one seen, so bursts between renders are kept.
  const seenSeq = useRef(feed.at(-1)?.seq ?? 0);
  useEffect(() => {
    const fresh = feed.filter((item) => item.seq > seenSeq.current);
    if (fresh.length === 0) return;
    seenSeq.current = fresh[fresh.length - 1].seq;
    const mine = fresh.map((item) => item.entry).filter((entry) => entry.teamId === teamId);
    if (mine.length > 0) setLog((previous) => mergeEntries(previous, mine));
  }, [feed, teamId]);

  return { log, loading, failed, reload: () => setAttempt((value) => value + 1) };
}
