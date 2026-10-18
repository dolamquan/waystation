import { useState } from 'react';
import type { NewTeamMember } from '../../api.ts';
import type { LaunchLoadout } from '../../library/loadoutApi.ts';
import { Icon } from '../Icon.tsx';
import { LoadoutPicker, isLoadoutEmpty } from '../LoadoutPicker.tsx';

export const MAX_FOCUS = 2000;

/** A member being set up in the New team dialog. `key` keeps rows stable while members are added or removed. */
export interface MemberDraft {
  readonly key: string;
  readonly name: string;
  readonly role: NewTeamMember['role'];
  readonly vendor: NewTeamMember['vendor'];
  readonly model?: string;
  readonly focus: string;
  readonly loadout: LaunchLoadout;
}

/** Plugins are Claude-only, so a Codex member never carries them. */
export function memberLoadout(loadout: LaunchLoadout, vendor: NewTeamMember['vendor']): LaunchLoadout | undefined {
  const { pluginIds, ...rest } = loadout;
  const forVendor = vendor === 'claude' && pluginIds ? { ...rest, pluginIds } : rest;
  return isLoadoutEmpty(forVendor) ? undefined : forVendor;
}

export function toNewMember(draft: MemberDraft): NewTeamMember {
  return {
    name: draft.name.trim().toLowerCase(),
    role: draft.role,
    vendor: draft.vendor,
    model: draft.model?.trim() || undefined,
    focus: draft.focus.trim() || undefined,
    loadout: memberLoadout(draft.loadout, draft.vendor),
  };
}

interface NewTeamMemberRowProps {
  readonly member: MemberDraft;
  readonly index: number;
  readonly codexAvailable: boolean;
  readonly canRemove: boolean;
  readonly modelListId: string;
  readonly onChange: (patch: Partial<MemberDraft>) => void;
  readonly onMakeLead: () => void;
  readonly onRemove: () => void;
}

export function NewTeamMemberRow({ member, index, codexAvailable, canRemove, modelListId, onChange, onMakeLead, onRemove }: NewTeamMemberRowProps) {
  // The picker loads the library lists, so it mounts only once the operator opens it.
  const [loadoutOpen, setLoadoutOpen] = useState(false);
  const label = `Member ${index + 1}`;
  return (
    <div className="team-member-draft">
      <div className="team-member-row">
        <button type="button" className={`lead-toggle ${member.role === 'lead' ? 'lead-on' : ''}`} onClick={onMakeLead} aria-pressed={member.role === 'lead'} title={member.role === 'lead' ? 'Team lead' : 'Make lead'}>
          {member.role === 'lead' ? 'Lead' : 'Worker'}
        </button>
        <input className="text-input" aria-label={`${label} name`} value={member.name} onChange={(e) => onChange({ name: e.target.value.toLowerCase() })} pattern="[a-z][a-z0-9-]{0,23}" title="Lowercase letters, digits and dashes" required />
        <select className="text-input" aria-label={`${label} agent`} value={member.vendor} onChange={(e) => onChange({ vendor: e.target.value as MemberDraft['vendor'] })}>
          <option value="claude">Claude</option>
          <option value="codex" disabled={!codexAvailable}>Codex</option>
        </select>
        <input className="text-input" aria-label={`${label} model`} list={modelListId} value={member.model ?? ''} onChange={(e) => onChange({ model: e.target.value })} placeholder="default model" />
        <button type="button" className="icon-btn" onClick={onRemove} disabled={!canRemove} aria-label={`Remove ${member.name}`}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <label className="team-member-focus-label">
        <span>What should {member.name || 'this member'} do? <span className="muted">({member.focus.length}/{MAX_FOCUS})</span></span>
        <textarea
          className="text-input team-member-focus-input"
          value={member.focus}
          onChange={(e) => onChange({ focus: e.target.value })}
          maxLength={MAX_FOCUS}
          rows={4}
          placeholder={member.role === 'lead' ? 'e.g. “Plan, coordinate and review every branch.”' : 'e.g. “Build the backend API and its tests. Do not touch the UI.”'}
        />
      </label>
      <details className="form-more team-member-loadout" onToggle={(e) => setLoadoutOpen(e.currentTarget.open)}>
        <summary>Skills, docs &amp; tools{isLoadoutEmpty(member.loadout) ? ' (optional)' : ' · selected'}</summary>
        {loadoutOpen && <LoadoutPicker vendor={member.vendor} value={member.loadout} onChange={(loadout) => onChange({ loadout })} />}
      </details>
    </div>
  );
}
