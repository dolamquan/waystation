import { useRef, useState, type FormEvent } from 'react';
import { api, type ConsoleKind } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { Modal } from '../Modal.tsx';
import { ProjectFolderInput } from '../ProjectFolderInput.tsx';
import {
  BUILT_IN_PRESETS, MAX_NAME_LENGTH, MAX_SLOTS, addPreset, loadPresets, removePreset, savePresets,
  type LayoutPreset, type PresetSlot,
} from './layoutPresets.ts';
import './launchComposer.css';

const KIND_LABELS: Readonly<Record<ConsoleKind, string>> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };
const KIND_ORDER: readonly ConsoleKind[] = ['claude', 'codex', 'shell'];

/** A slot in the grid; `key` is stable across edits so removing one does not shift typed names onto another. */
interface Slot extends PresetSlot { readonly key: number }
interface Failure { readonly label: string; readonly message: string }

const slotLabel = (slot: PresetSlot, index: number): string => slot.name ?? `${KIND_LABELS[slot.kind]} ${index + 1}`;

/** Sequential on purpose: the daemon spawns a PTY per call, and ordered tiles beat a thundering herd. */
async function launchAll(slots: readonly Slot[], cwd: string) {
  const ids: string[] = [];
  const failedKeys = new Set<number>();
  const failures: Failure[] = [];
  for (const [index, slot] of slots.entries()) {
    try {
      const { console: created } = await api.openConsole({ kind: slot.kind, cwd, ...(slot.name ? { name: slot.name } : {}) });
      ids.push(created.id);
    } catch (error) {
      failedKeys.add(slot.key);
      failures.push({ label: slotLabel(slot, index), message: (error as Error).message });
    }
  }
  return { ids, failedKeys, failures };
}

function PresetStrip({ saved, onApply, onDelete, onSave, canSave }: {
  readonly saved: readonly LayoutPreset[];
  readonly onApply: (preset: LayoutPreset) => void;
  readonly onDelete: (preset: LayoutPreset) => void;
  readonly onSave: (name: string) => void;
  readonly canSave: boolean;
}) {
  const [name, setName] = useState('');
  const save = () => { if (name.trim()) { onSave(name); setName(''); } };
  return <div className="composer-presets" role="group" aria-label="Layout presets">
    <div className="composer-preset-list">
      {BUILT_IN_PRESETS.map((preset) => <button key={preset.id} type="button" className="composer-chip" onClick={() => onApply(preset)}
        title={preset.slots.map((slot) => KIND_LABELS[slot.kind]).join(' + ')}>{preset.name}</button>)}
      {saved.map((preset) => <span key={preset.id} className="composer-chip composer-chip-saved">
        <button type="button" onClick={() => onApply(preset)} title={preset.slots.map((slot) => KIND_LABELS[slot.kind]).join(' + ')}>{preset.name}</button>
        <button type="button" className="composer-chip-x" onClick={() => onDelete(preset)} aria-label={`Delete preset ${preset.name}`}><Icon name="close" size={12} /></button>
      </span>)}
    </div>
    <div className="composer-save">
      <input className="text-input" value={name} maxLength={MAX_NAME_LENGTH} placeholder="Save this layout as…" aria-label="Preset name"
        onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
      <button type="button" className="btn" disabled={!name.trim() || !canSave} onClick={save}>Save preset</button>
    </div>
  </div>;
}

function SlotRow({ slot, index, onChange, onRemove, canRemove }: {
  readonly slot: Slot;
  readonly index: number;
  readonly onChange: (patch: Partial<PresetSlot>) => void;
  readonly onRemove: () => void;
  readonly canRemove: boolean;
}) {
  return <li className="composer-slot">
    <span className="composer-slot-n" aria-hidden="true">{index + 1}</span>
    <select className="text-input" value={slot.kind} aria-label={`Slot ${index + 1} type`} onChange={(event) => onChange({ kind: event.target.value as ConsoleKind })}>
      {KIND_ORDER.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
    </select>
    <input className="text-input" value={slot.name ?? ''} maxLength={MAX_NAME_LENGTH} placeholder="Name (optional)" aria-label={`Slot ${index + 1} name`}
      onChange={(event) => onChange({ name: event.target.value })} />
    <button type="button" className="icon-btn" disabled={!canRemove} onClick={onRemove} aria-label={`Remove slot ${index + 1}`} title="Remove slot"><Icon name="close" size={15} /></button>
  </li>;
}

/** Launch a whole set of consoles in one folder, with built-in and saved layout presets. */
export function LaunchComposer({ defaultCwd, notify, onLaunched, onClose, asTeamByDefault = false }: {
  readonly defaultCwd: string | undefined;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** `team` is the team name when the consoles should be bundled as a team on the canvas. */
  readonly onLaunched: (ids: readonly string[], team?: string) => void;
  readonly onClose: () => void;
  /** Opened from "Spawn team": the team option starts on. */
  readonly asTeamByDefault?: boolean;
}) {
  const [asTeam, setAsTeam] = useState(asTeamByDefault);
  const [teamName, setTeamName] = useState('');
  const nextKey = useRef(0);
  const makeSlots = (source: readonly PresetSlot[]): Slot[] => source.map((slot) => ({ ...slot, key: nextKey.current++ }));
  const [slots, setSlots] = useState<readonly Slot[]>(() => makeSlots([{ kind: 'claude' }, { kind: 'claude' }]));
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [saved, setSaved] = useState<readonly LayoutPreset[]>(() => loadPresets());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<readonly Failure[]>([]);

  const updateSaved = (next: readonly LayoutPreset[]) => {
    setSaved(next);
    if (!savePresets(next)) notify('Presets could not be stored in this browser, so they will be lost on reload.', 'error');
  };
  const applyPreset = (preset: LayoutPreset) => { setSlots(makeSlots(preset.slots)); setFailures([]); };
  const savePreset = (name: string) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `preset-${Date.now()}`;
    updateSaved(addPreset(saved, { id, name: name.trim(), slots: slots.map(({ kind, name: slotName }) => (slotName?.trim() ? { kind, name: slotName.trim() } : { kind })) }));
  };
  const patchSlot = (key: number, patch: Partial<PresetSlot>) => setSlots((current) => current.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)));
  const addSlot = () => setSlots((current) => (current.length >= MAX_SLOTS ? current : [...current, ...makeSlots([{ kind: 'claude' }])]));

  const folder = cwd.trim();
  const canLaunch = !busy && folder !== '' && slots.length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canLaunch) return;
    setBusy(true);
    setFailures([]);
    const result = await launchAll(slots.map((slot) => ({ ...slot, name: slot.name?.trim() || undefined })), folder);
    setBusy(false);
    const team = asTeam && result.ids.length >= 2 ? teamName.trim() || 'Team' : undefined;
    if (result.ids.length > 0) onLaunched(result.ids, team);
    if (result.failures.length === 0) {
      notify(`Launched ${result.ids.length} console${result.ids.length === 1 ? '' : 's'}`);
      onClose();
      return;
    }
    // Keep only the slots that failed so a retry does not duplicate the ones that started.
    setSlots((current) => current.filter((slot) => result.failedKeys.has(slot.key)));
    setFailures(result.failures);
    notify(`${result.ids.length} launched, ${result.failures.length} failed`, 'error');
  };

  return <Modal title={asTeamByDefault ? 'Spawn a team' : 'Launch several consoles'} onClose={onClose} className="composer">
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-body">
        <PresetStrip saved={saved} onApply={applyPreset} onDelete={(preset) => updateSaved(removePreset(saved, preset.id))} onSave={savePreset} canSave={slots.length > 0} />
        <ol className="composer-slots" aria-label="Console slots">
          {slots.map((slot, index) => <SlotRow key={slot.key} slot={slot} index={index} canRemove={slots.length > 1}
            onChange={(patch) => patchSlot(slot.key, patch)} onRemove={() => setSlots((current) => current.filter((candidate) => candidate.key !== slot.key))} />)}
        </ol>
        <button type="button" className="btn btn-ghost composer-add" disabled={slots.length >= MAX_SLOTS} onClick={addSlot}>
          <Icon name="plus" size={14} />Add slot ({slots.length}/{MAX_SLOTS})
        </button>
        <ProjectFolderInput value={cwd} onChange={setCwd} />
        <div className="composer-team">
          <label className="composer-team-toggle">
            <input type="checkbox" checked={asTeam} onChange={(event) => setAsTeam(event.target.checked)} />
            Bundle as a team on the canvas
          </label>
          {asTeam && <input className="text-input" value={teamName} maxLength={MAX_NAME_LENGTH} placeholder="Team name (optional)" aria-label="Team name"
            onChange={(event) => setTeamName(event.target.value)} />}
          {asTeam && <p className="console-note">The consoles open side by side in one frame you can move, pause, resume and hand tasks around in. Slot names become their roles (e.g. Lead, Reviewer).</p>}
        </div>
        {failures.length > 0 && <div className="composer-failures" role="alert">
          <strong>{failures.length} slot{failures.length === 1 ? '' : 's'} failed to start (the rest are running):</strong>
          <ul>{failures.map((failure, index) => <li key={index}>{failure.label}: {failure.message}</li>)}</ul>
        </div>}
        <p className="console-note">Each slot is a real terminal with the CLI’s own prompts and permissions.</p>
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={!canLaunch}>
          {busy ? 'Launching…' : `Launch ${slots.length} console${slots.length === 1 ? '' : 's'}`}
        </button>
      </footer>
    </form>
  </Modal>;
}
