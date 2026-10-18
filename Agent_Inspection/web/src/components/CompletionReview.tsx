import { useEffect, useId, useRef, useState } from 'react';
import { api, type Agent } from '../api.ts';
import type { CompletionReview as Review } from '../../../daemon/outputs/review.ts';
import { MessageText } from './ActivityFeed.tsx';
import { Icon } from './Icon.tsx';
import '../session-history.css';

export function CompletionReview({ agent, refreshKey }: { readonly agent: Agent; readonly refreshKey: number }) {
  const uid = useId();
  const [review, setReview] = useState<Review>();
  const [acceptance, setAcceptance] = useState('');
  const [unresolved, setUnresolved] = useState('');
  const [checksReviewed, setChecksReviewed] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState('');
  const fingerprint = useRef<string | undefined>(undefined);
  useEffect(() => {
    let ignore = false;
    api.completionReview(agent.id).then(result => {
      if (ignore) return;
      if (!fingerprint.current) {
        setAcceptance(result.review.saved?.acceptance ?? '');
        setUnresolved(result.review.saved?.unresolved ?? '');
        setChecksReviewed(result.review.saved?.checksReviewed === true && !result.review.stale);
      } else if (fingerprint.current !== result.review.fingerprint) setChecksReviewed(false);
      fingerprint.current = result.review.fingerprint;
      setReview(result.review); setError(undefined);
    }, failure => { if (!ignore) setError(failure.message); });
    return () => { ignore = true; };
  }, [agent.id, refreshKey, reload]);
  const save = async (decision: 'reviewed' | 'verified') => {
    if (!review) return;
    setSaving(true); setNotice('');
    try {
      const result = await api.saveCompletionReview(agent.id, { fingerprint: review.fingerprint, decision, acceptance, unresolved, checksReviewed });
      setReview(result.review); setError(undefined);
      setNotice(decision === 'verified' ? 'Work marked verified by you for this conversation and file snapshot.' : 'Review notes saved. The work remains unverified.');
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="completion-review" aria-labelledby={`${uid}-title`}>
    <div className="detail-section-heading"><div><h3 id={`${uid}-title`}>Completion review</h3><p>Check the request, evidence, and files before accepting the work.</p></div><button className="icon-btn" aria-label="Refresh completion review" disabled={saving} onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={16} /></button></div>
    {error && <p className="outputs-error" role="alert">{error}</p>}
    {!review ? <p>Loading completion review…</p> : <>
      <div className="review-state" role="status"><strong>{review.status === 'verified' ? 'Work verified by you' : review.status === 'reviewed' ? 'Reviewed · work not verified' : 'Needs review'}</strong><span>{review.agentFinished ? 'Agent finished its latest turn' : 'Latest turn has not finished successfully'}</span></div>
      {review.stale && <p className="review-stale">The conversation or files changed since your last review. Check the current work before verifying again.</p>}
      <div className="review-request"><h4>Original request</h4><p>{review.originalRequest ?? 'The original request was not recorded.'}</p></div>
      <div className="review-request"><h4>Latest result</h4><p>{review.result ? <MessageText text={review.result} /> : 'No result recorded yet.'}</p></div>
      <section className="review-checks" aria-labelledby={`${uid}-checks`}><h4 id={`${uid}-checks`}>Recorded checks</h4>
        {review.checks.length ? <ol>{review.checks.map((check, index) => <li key={`${check.ts}-${index}`}><div><span className={`message-state message-state-${check.outcome === 'passed' ? 'delivered' : check.outcome === 'failed' ? 'review' : 'queued'}`}>{check.outcome === 'passed' ? 'Passed' : check.outcome === 'failed' ? 'Failed' : 'Outcome unknown'}</span><code>{check.command}</code></div>{check.output && <details><summary>View recorded output</summary><pre>{check.output}</pre></details>}</li>)}</ol> : <p className="session-help">No test or validation outcomes were recorded for this turn. An agent’s claim that tests passed is not verification evidence.</p>}
      </section>
      {review.errors.length > 0 && <section><h4>Recorded issues</h4><ul className="outputs-turn-errors">{review.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul></section>}
      {review.limitations.length > 0 && <ul className="outputs-turn-errors">{review.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>}
      <form className="review-form" onSubmit={event => { event.preventDefault(); void save('reviewed'); }}>
        <label htmlFor={`${uid}-acceptance`}>How did you check the request?</label><textarea id={`${uid}-acceptance`} className="text-input" rows={3} value={acceptance} onChange={event => setAcceptance(event.target.value)} maxLength={8000} placeholder="Describe the behavior you checked and the acceptance criteria it meets." disabled={saving} />
        <label htmlFor={`${uid}-unresolved`}>Unresolved issues</label><textarea id={`${uid}-unresolved`} className="text-input" rows={2} value={unresolved} onChange={event => setUnresolved(event.target.value)} maxLength={8000} placeholder="Record anything still needed. Leave empty when resolved." disabled={saving} />
        <label className="check"><input type="checkbox" checked={checksReviewed} onChange={event => setChecksReviewed(event.target.checked)} disabled={saving} />I reviewed the applicable tests and file changes, including any missing test evidence.</label>
        <p className="session-help">Inspect the changed files and their diffs below. Verification records your acceptance of this snapshot; it does not run tests.</p>
        <div className="session-actions"><button className="btn btn-small" type="submit" disabled={saving}>Save review notes</button><button className="btn btn-small btn-go" type="button" disabled={saving || !review.agentFinished || !acceptance.trim() || !checksReviewed || !!unresolved.trim()} onClick={() => void save('verified')}>Mark work verified</button></div>
      </form>
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
