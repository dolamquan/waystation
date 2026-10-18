import { useId, useState, type RefObject } from 'react';
import { api, type TeamView } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { canResume, findMember, resumeGrantText, type RunAction } from './teamUi.ts';

interface TeamComposerProps {
  readonly team: TeamView;
  readonly to: string;
  readonly onToChange: (to: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly busy?: string;
  readonly unavailable: boolean;
  readonly run: RunAction;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

/** What happens to a message, said before it is sent. */
function deliveryNote(team: TeamView, to: string): string | undefined {
  const recipient = findMember(team, to);
  const planning = team.status === 'planning' || team.status === 'plan_review';
  if (team.status === 'plan_review' && recipient?.role === 'lead') return 'This goes to the lead as feedback on its plan. The lead revises it and submits it again.';
  if (planning && recipient?.role !== 'lead') return 'Teammates receive this after you approve the plan. Messages to the lead arrive now.';
  if (canResume(team)) return 'Send queues your message until the team resumes. Send & resume delivers it now and renews the run limits.';
  return undefined;
}

export function TeamComposer({ team, to, onToChange, inputRef, busy, unavailable, run, notify }: TeamComposerProps) {
  const id = useId();
  const [text, setText] = useState('');
  const resumable = canResume(team);
  const note = deliveryNote(team, to);
  const empty = !text.trim();

  const send = (resume: boolean) => {
    const body = text.trim();
    if (!body) return;
    void run(resume ? 'send-resume' : 'send', async () => {
      const result = await api.messageTeam(team.id, to, body);
      setText('');
      notify(result.message);
      if (!resume) return;
      await api.resumeTeam(team.id);
      notify(`Team resumed (${resumeGrantText(team)}). Your message is being delivered.`);
    });
  };

  return (
    <form className="team-composer" onSubmit={(event) => { event.preventDefault(); send(false); }}>
      <label className="session-message-label" htmlFor={`${id}-message`}>Message {to === 'all' ? 'the team' : to}</label>
      <textarea
        ref={inputRef}
        id={`${id}-message`}
        className="text-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Share direction, ask a question, or add context…"
        aria-label="Message"
        maxLength={8000}
        rows={3}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (!unavailable) event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="session-composer-footer">
        <label className="session-recipient">
          <Icon name="crew" size={15} /><span>To</span>
          <select value={to} onChange={(e) => onToChange(e.target.value)} aria-label="Recipient">
            <option value="all">Everyone</option>
            {team.members.map((m) => <option key={m.id} value={m.name}>{m.name}{m.role === 'lead' ? ' (lead)' : ''}</option>)}
          </select>
        </label>
        <span className="session-send-hint">Ctrl / ⌘ + Enter to send</span>
        <div className="team-send-actions">
          <button className={`btn ${resumable ? '' : 'btn-go'}`} type="submit" disabled={empty || unavailable}>
            <Icon name="send" size={15} />{busy === 'send' ? 'Sending…' : 'Send'}
          </button>
          {resumable && (
            <button className="btn btn-go" type="button" disabled={empty || unavailable} aria-describedby={`${id}-grant`} onClick={() => send(true)}>
              <Icon name="play" size={15} />{busy === 'send-resume' ? 'Resuming…' : 'Send & resume'}
            </button>
          )}
        </div>
      </div>
      {resumable && <p className="session-composer-note team-grant" id={`${id}-grant`}>Resuming adds {resumeGrantText(team)}.</p>}
      {note && <p className="session-composer-note">{note}</p>}
    </form>
  );
}
