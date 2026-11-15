import { useState } from 'react';
import type { ChannelCandidate } from './ChannelsPanel.tsx';
import { addMember, createChannel } from './channelsApi.ts';
import { channelSlug, eligibleCandidates, friendlyError } from './teamLogic.ts';

interface NewTeamFormProps {
  readonly candidates: readonly ChannelCandidate[];
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onCreated: (channelId: string) => void;
  readonly onCancel: () => void;
}

/** Name, purpose and starting members. Members are added one by one after the team exists, so one failure does not lose the team. */
export function NewTeamForm({ candidates, notify, onCreated, onCancel }: NewTeamFormProps) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const options = eligibleCandidates(candidates, undefined);
  const slug = channelSlug(name);

  const toggle = (id: string) => setPicked((now) => now.includes(id) ? now.filter((x) => x !== id) : [...now, id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!slug || busy) return;
    setBusy(true);
    try {
      const channel = await createChannel({ name: name.trim(), purpose: purpose.trim() || undefined });
      const failures: string[] = [];
      for (const id of picked) {
        const label = options.find((c) => c.agentId === id)?.label ?? id;
        try { await addMember(channel.id, id, label); } catch (error) { failures.push(`${label}: ${friendlyError(error)}`); }
      }
      if (failures.length) notify(`Team created, but ${failures.join('; ')}`, 'error');
      else notify(`Team #${channel.name} created.`);
      onCreated(channel.id);
    } catch (error) {
      notify(friendlyError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="chan-form" onSubmit={submit}>
      <label className="chan-field">Team name
        <input className="chan-input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="e.g. fix the build" autoFocus />
      </label>
      {name.trim() && <p className="chan-hint">{slug ? `Will be called #${slug}` : 'Use at least one letter or digit.'}</p>}
      <label className="chan-field">Purpose (optional)
        <textarea className="chan-input" rows={2} value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder="What should they work on together?" />
      </label>
      <fieldset className="chan-field chan-picks">
        <legend>Members</legend>
        {options.length === 0 && <p className="chan-hint">No running sessions to add. Open a terminal or start an agent first; you can add members later.</p>}
        {options.map((c) => (
          <label key={c.agentId} className="chan-pick">
            <input type="checkbox" checked={picked.includes(c.agentId)} onChange={() => toggle(c.agentId)} />
            <span className="chan-pick-label">{c.label}</span>
            <span className={`chan-origin chan-origin-${c.origin}`}>{c.origin}</span>
          </label>
        ))}
      </fieldset>
      <div className="chan-actions">
        <button type="button" className="chan-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="chan-btn chan-btn-primary" disabled={!slug || busy}>{busy ? 'Creating...' : 'Create team'}</button>
      </div>
    </form>
  );
}
