import { useEffect, useId, useState } from 'react';
import { api, type NewSchedule, type ScheduleView } from '../api.ts';
import { loadoutApi, type LaunchLoadout, type NotifyChannelView } from '../library/loadoutApi.ts';
import type { ResourceKind, ScheduleNotifyWhen } from '../../../daemon/library/types.ts';
import type { Vendor } from '../models.ts';
import { Icon } from './Icon.tsx';
import { LoadoutPicker } from './LoadoutPicker.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import '../library/schedules.css';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const MAX_RESOURCES = 30;
const MAX_UPLOAD_BYTES = 512 * 1024;
const LOADOUT_SECTIONS = ['skillIds', 'docIds', 'mcpIds', 'pluginIds'] as const;

type DraftResource = NonNullable<NewSchedule['resources']>[number];

interface ScheduleFormProps {
  readonly defaultCwd?: string;
  /** Present when editing. */
  readonly schedule?: ScheduleView;
  readonly onDone: () => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

export const RESOURCE_KINDS: ReadonlyArray<{ kind: ResourceKind; label: string; placeholder: string }> = [
  { kind: 'github', label: 'GitHub repo', placeholder: 'owner/repo, owner/repo@branch or a github.com link' },
  { kind: 'url', label: 'Web page', placeholder: 'https://example.com/changelog' },
  { kind: 'file', label: 'File path', placeholder: 'C:\\Users\\you\\data\\feeds.csv' },
  { kind: 'folder', label: 'Folder path', placeholder: 'C:\\Users\\you\\exports' },
  { kind: 'note', label: 'Note', placeholder: 'Anything the agent should know, e.g. which pages matter' },
];

const kindLabel = (kind: ResourceKind) => RESOURCE_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Create or edit a schedule: when, what, the resources it needs, and who hears about each run. */
export function ScheduleForm({ defaultCwd, schedule, onDone, notify }: ScheduleFormProps) {
  const [label, setLabel] = useState(schedule?.label ?? '');
  const [vendor, setVendor] = useState<Vendor>(schedule?.launch.vendor ?? 'claude');
  const [model, setModel] = useState(schedule?.launch.model ?? '');
  const [cwd, setCwd] = useState(schedule?.launch.cwd ?? defaultCwd ?? '');
  const [prompt, setPrompt] = useState(schedule?.launch.prompt ?? '');
  const [time, setTime] = useState(schedule?.time ?? '09:00');
  const [days, setDays] = useState<readonly number[]>(schedule?.days ?? WEEKDAYS);
  const [resources, setResources] = useState<readonly DraftResource[]>(schedule?.resources ?? []);
  const [uploads, setUploads] = useState<readonly File[]>([]);
  const [loadout, setLoadout] = useState<LaunchLoadout>(schedule?.launch.loadout ?? {});
  const [channelIds, setChannelIds] = useState<readonly string[]>(schedule?.notify?.channelIds ?? []);
  const [when, setWhen] = useState<ScheduleNotifyWhen>(schedule?.notify?.when ?? 'always');
  const [stopWhenDone, setStopWhenDone] = useState(schedule?.stopWhenDone ?? true);
  const [maxMinutes, setMaxMinutes] = useState(schedule?.maxMinutes ?? 60);
  const [busy, setBusy] = useState(false);

  const toggleDay = (day: number) => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));

  const body = (): NewSchedule => ({
    label: label.trim(), time, days, enabled: schedule?.enabled ?? true,
    launch: {
      vendor, cwd: cwd.trim(), prompt, name: schedule?.launch.name ?? label.trim(), model: model || undefined,
      appendSystemPrompt: schedule?.launch.appendSystemPrompt, intercept: schedule?.launch.intercept,
      loadout: Object.keys(loadout).length ? loadout : undefined,
    },
    resources, notify: { channelIds, when }, stopWhenDone, maxMinutes,
  });

  const uploadAll = async (id: string) => {
    for (const file of uploads) {
      await api.uploadScheduleResource(id, { filename: file.name, contentBase64: await readBase64(file) });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = schedule ? await api.updateSchedule(schedule.id, body()) : await api.createSchedule(body());
      await uploadAll(saved.schedule.id);
      notify(schedule ? `Saved ${label.trim()}` : `Scheduled ${label.trim()}`);
      onDone();
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="form ops-form schedule-form" onSubmit={(e) => void submit(e)} aria-label={schedule ? `Edit ${schedule.label}` : 'New schedule'}>
      <header className="schedule-form-head"><div><h3>{schedule ? `Edit ${schedule.label}` : 'Create a recurring task'}</h3><p>Set the timing and task. Add resources and delivery options if you need them.</p></div></header>
      <fieldset className="schedule-step"><legend><span>1</span> When should it run?</legend>
      <div className="form-pair">
        <label>Schedule name<input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required placeholder="e.g. Morning PR review" autoFocus /></label>
        <label>Time (local)<input className="text-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></label>
      </div>
      <fieldset className="day-picker"><legend>Days</legend>
        {DAY_NAMES.map((dayName, day) => (
          <button type="button" key={dayName} className={days.includes(day) ? 'day-on' : ''} aria-pressed={days.includes(day)} onClick={() => toggleDay(day)}>{dayName}</button>
        ))}
      </fieldset>
      {days.length === 0 && <small className="error-text" role="status">Choose at least one day.</small>}
      </fieldset>
      <fieldset className="schedule-step"><legend><span>2</span> What should the agent do?</legend>
      <div className="form-pair">
        <label>Agent
          <select className="text-input" value={vendor} onChange={(e) => { setVendor(e.target.value as Vendor); setModel(''); }}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <div className="form-field"><span>Model</span><ModelPicker key={vendor} vendor={vendor} value={model} onChange={setModel} /></div>
      </div>
      <label>Project folder (absolute path)<input className="text-input" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder="C:\Users\you\project" /></label>
      <label>Task<textarea className="text-input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} required placeholder="What should the agent do each time?" /></label>
      </fieldset>
      <details className="schedule-options"><summary><Icon name="folder" size={17} /><span>Resources &amp; agent tools<small>Optional · files, links, skills and project context</small></span><Icon name="chevronDown" size={16} /></summary><div>
      <ResourcesEditor resources={resources} onChange={setResources} uploads={uploads} onUploads={setUploads} notify={notify} />
      <fieldset className="schedule-fieldset"><legend>Skills, docs and tools</legend>
        <LoadoutPicker vendor={vendor === 'codex' ? 'codex' : 'claude'} value={loadout} onChange={setLoadout} sections={LOADOUT_SECTIONS} />
      </fieldset>
      </div></details>
      <details className="schedule-options"><summary><Icon name="message" size={17} /><span>Notifications &amp; run limits<small>{when === 'never' ? 'Channel notifications off' : when === 'failure' ? 'Channel updates on failure' : 'Channel updates after every run'} · {maxMinutes} minute limit</small></span><Icon name="chevronDown" size={16} /></summary><div>
      <NotifyEditor channelIds={channelIds} onChannels={setChannelIds} when={when} onWhen={setWhen} />
      <div className="form-pair">
        <label className="check"><input type="checkbox" checked={stopWhenDone} onChange={(e) => setStopWhenDone(e.target.checked)} />Stop the agent when it finishes</label>
        <label>Time limit (minutes)<input className="text-input" type="number" min={1} max={600} value={maxMinutes} onChange={(e) => setMaxMinutes(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} /></label>
      </div>
      </div></details>
      <div className="detail-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={busy || days.length === 0}>{busy ? 'Saving…' : schedule ? 'Save changes' : 'Save schedule'}</button>
      </div>
    </form>
  );
}

interface ResourcesEditorProps {
  readonly resources: readonly DraftResource[];
  readonly onChange: (next: readonly DraftResource[]) => void;
  readonly uploads: readonly File[];
  readonly onUploads: (next: readonly File[]) => void;
  readonly notify: ScheduleFormProps['notify'];
}

/** The repos, pages, files, folders and notes the agent needs for the task. */
function ResourcesEditor({ resources, onChange, uploads, onUploads, notify }: ResourcesEditorProps) {
  const [kind, setKind] = useState<ResourceKind>('github');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const fileId = useId();
  const full = resources.length + uploads.length >= MAX_RESOURCES;
  const placeholder = RESOURCE_KINDS.find((entry) => entry.kind === kind)?.placeholder;

  const add = () => {
    if (!value.trim() || full) return;
    onChange([...resources, { kind, value: value.trim(), ...(label.trim() ? { label: label.trim() } : {}) }]);
    setValue('');
    setLabel('');
  };

  const pick = (files: FileList | null) => {
    const chosen = [...(files ?? [])];
    const tooBig = chosen.filter((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooBig.length) notify(`${tooBig.map((file) => file.name).join(', ')}: files are limited to 512 KB`, 'error');
    onUploads([...uploads, ...chosen.filter((file) => file.size <= MAX_UPLOAD_BYTES)].slice(0, MAX_RESOURCES - resources.length));
  };

  return (
    <fieldset className="schedule-fieldset"><legend>Resources</legend>
      <p className="schedule-hint">What the agent needs to reach for this task. GitHub repos are cloned (or pulled if already there), pages are fetched, paths are read.</p>
      {resources.length + uploads.length > 0 && (
        <ul className="schedule-resources">
          {resources.map((resource, index) => (
            <li key={resource.id ?? `new-${index}`}>
              <span className="meta-chip">{kindLabel(resource.kind)}</span>
              <span className="schedule-resource-value">{resource.label ? <strong>{resource.label} </strong> : null}{resource.value}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${resource.label ?? resource.value}`} onClick={() => onChange(resources.filter((_, i) => i !== index))}><Icon name="close" size={13} /></button>
            </li>
          ))}
          {uploads.map((file, index) => (
            <li key={`upload-${file.name}-${index}`}>
              <span className="meta-chip">Upload</span>
              <span className="schedule-resource-value">{file.name} <small>(uploaded when you save)</small></span>
              <button type="button" className="icon-btn" aria-label={`Remove ${file.name}`} onClick={() => onUploads(uploads.filter((_, i) => i !== index))}><Icon name="close" size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="schedule-resource-add">
        <label>Kind
          <select className="text-input" value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)}>
            {RESOURCE_KINDS.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}
          </select>
        </label>
        <label className="schedule-resource-input">{kind === 'note' ? 'Note' : 'Value'}
          {kind === 'note'
            ? <textarea className="text-input" rows={2} maxLength={4000} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
            : <input className="text-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />}
        </label>
        <label>Label (optional)<input className="text-input" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <button type="button" className="btn btn-small" onClick={add} disabled={!value.trim() || full}><Icon name="plus" size={14} />Add</button>
      </div>
      <div className="schedule-upload">
        <label htmlFor={fileId} className="btn btn-small btn-ghost"><Icon name="folder" size={14} />Upload a file…</label>
        <input id={fileId} className="sr-only" type="file" multiple disabled={full} onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        <small>Up to 512 KB each, kept with the schedule.</small>
      </div>
    </fieldset>
  );
}

interface NotifyEditorProps {
  readonly channelIds: readonly string[];
  readonly onChannels: (next: readonly string[]) => void;
  readonly when: ScheduleNotifyWhen;
  readonly onWhen: (next: ScheduleNotifyWhen) => void;
}

const WHEN_OPTIONS: ReadonlyArray<{ value: ScheduleNotifyWhen; label: string }> = [
  { value: 'always', label: 'After every run' },
  { value: 'failure', label: 'Only when a run fails' },
  { value: 'never', label: 'Never' },
];

/** Where each run's outcome goes. The Updates inbox always gets it. */
function NotifyEditor({ channelIds, onChannels, when, onWhen }: NotifyEditorProps) {
  const [channels, setChannels] = useState<readonly NotifyChannelView[]>([]);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let live = true;
    loadoutApi.notifyChannels()
      .then((result) => { if (live) setChannels(result.channels.filter((channel) => channel.id !== 'inbox')); })
      .catch((err: Error) => { if (live) setLoadError(err.message); });
    return () => { live = false; };
  }, []);

  const toggle = (id: string) => onChannels(channelIds.includes(id) ? channelIds.filter((c) => c !== id) : [...channelIds, id]);

  return (
    <fieldset className="schedule-fieldset"><legend>Notifications</legend>
      <label>Send an update
        <select className="text-input" value={when} onChange={(e) => onWhen(e.target.value as ScheduleNotifyWhen)}>
          {WHEN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div className="schedule-channels" role="group" aria-label="Notification channels">
        <label className="check"><input type="checkbox" checked disabled readOnly />Updates inbox</label>
        {channels.map((channel) => (
          <label className="check" key={channel.id}>
            <input type="checkbox" checked={channelIds.includes(channel.id)} disabled={when === 'never'} onChange={() => toggle(channel.id)} />
            {channel.label} <small>({channel.kind}{channel.enabled ? '' : ', off'})</small>
          </label>
        ))}
      </div>
      {loadError && <small role="alert">Couldn’t load channels: {loadError}</small>}
      {!loadError && channels.length === 0 && <small className="schedule-hint">Add Slack, Discord, email and more under Library → Notifications.</small>}
    </fieldset>
  );
}
