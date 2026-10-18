import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { loadoutApi, type LaunchLoadout } from '../library/loadoutApi.ts';
import '../library/loadout.css';

export type LoadoutSection = keyof LaunchLoadout;

export interface LoadoutPickerProps {
  readonly vendor: 'claude' | 'codex';
  readonly value: LaunchLoadout;
  readonly onChange: (next: LaunchLoadout) => void;
  /** Which sections to show; all by default. */
  readonly sections?: ReadonlyArray<LoadoutSection>;
}

/** One row in a section checklist, whatever library list it came from. */
interface LoadoutOption {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly tag?: string;
  /** Shown checked and disabled with this note, e.g. a plugin enabled globally in Claude Code. */
  readonly lockedOn?: string;
}

type SectionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly options: readonly LoadoutOption[] }
  | { readonly status: 'error'; readonly message: string };

interface SectionMeta {
  readonly legend: string;
  readonly caption: string;
  readonly noun: [singular: string, plural: string];
  readonly empty: string;
  readonly load: () => Promise<LoadoutOption[]>;
}

const ALL_SECTIONS: readonly LoadoutSection[] = ['skillIds', 'docIds', 'mcpIds', 'pluginIds', 'notifyChannelIds'];
const SEARCH_THRESHOLD = 6;

const SECTION_META: Readonly<Record<LoadoutSection, SectionMeta>> = {
  skillIds: {
    legend: 'Skills',
    caption: 'Reusable instructions the agent can use.',
    noun: ['skill', 'skills'],
    empty: 'No skills yet. Create one in the Library.',
    load: async () => (await loadoutApi.skills()).skills.map((s) => ({
      id: s.id, title: s.name, detail: s.description || undefined, tag: s.source === 'waystation' ? 'WayStation' : s.source,
    })),
  },
  docIds: {
    legend: 'Context docs',
    caption: 'The agent reads these before starting.',
    noun: ['doc', 'docs'],
    empty: 'No context docs yet. Add .md files in the Library.',
    load: async () => (await loadoutApi.docs()).docs.map((d) => ({
      id: d.id, title: d.title, detail: d.filename, tag: formatBytes(d.bytes),
    })),
  },
  mcpIds: {
    legend: 'MCP servers',
    caption: 'Extra tools the agent can call.',
    noun: ['MCP server', 'MCP servers'],
    empty: 'No MCP servers yet. Add one in the Library.',
    load: async () => (await loadoutApi.mcp()).servers.map((m) => ({
      id: m.id, title: m.label || m.name, detail: m.label && m.label !== m.name ? m.name : undefined, tag: m.transport,
    })),
  },
  pluginIds: {
    legend: 'Plugins',
    caption: 'Installed Claude Code plugins.',
    noun: ['plugin', 'plugins'],
    empty: 'No Claude Code plugins installed. Manage plugins in the Library.',
    load: async () => (await loadoutApi.plugins()).plugins.map((p) => ({
      id: p.id, title: p.name, detail: p.description, tag: p.marketplace,
      lockedOn: p.enabledGlobally ? 'Always on (enabled in Claude Code)' : undefined,
    })),
  },
  notifyChannelIds: {
    legend: 'Notifications',
    caption: 'Gives the agent a notify tool to post updates.',
    noun: ['channel', 'channels'],
    empty: 'No notification channels yet. Add one in the Library.',
    load: async () => (await loadoutApi.notifyChannels()).channels
      .filter((c) => c.enabled)
      .map((c) => ({ id: c.id, title: c.label, tag: c.kind })),
  },
};

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Returns a loadout with that section replaced, dropping it when empty. */
function withSection(loadout: LaunchLoadout, key: LoadoutSection, ids: readonly string[]): LaunchLoadout {
  const { [key]: _old, ...rest } = loadout;
  return ids.length ? { ...rest, [key]: ids } : rest;
}

export function isLoadoutEmpty(loadout: LaunchLoadout | undefined): boolean {
  return !loadout || ALL_SECTIONS.every((key) => !loadout[key]?.length);
}

/** MCP servers and plugins marked "pre-select in New agent". Lists that fail to load contribute nothing. */
export async function defaultLoadout(): Promise<LaunchLoadout> {
  const [mcp, plugins] = await Promise.allSettled([loadoutApi.mcp(), loadoutApi.plugins()]);
  const mcpIds = mcp.status === 'fulfilled' ? mcp.value.servers.filter((s) => s.defaultOn).map((s) => s.id) : [];
  const pluginIds = plugins.status === 'fulfilled'
    ? plugins.value.plugins.filter((p) => p.defaultOn && !p.enabledGlobally).map((p) => p.id)
    : [];
  return withSection(withSection({}, 'mcpIds', mcpIds), 'pluginIds', pluginIds);
}

function useSectionLists(keys: readonly LoadoutSection[]) {
  const [lists, setLists] = useState<Partial<Record<LoadoutSection, SectionState>>>(
    () => Object.fromEntries(keys.map((key) => [key, { status: 'loading' }])),
  );
  const keyList = keys.join(',');
  useEffect(() => {
    let ignore = false;
    const wanted = keyList.split(',') as LoadoutSection[];
    void Promise.allSettled(wanted.map((key) => SECTION_META[key].load())).then((results) => {
      if (ignore) return;
      setLists(Object.fromEntries(results.map((result, i) => [wanted[i], result.status === 'fulfilled'
        ? { status: 'ready', options: result.value }
        : { status: 'error', message: (result.reason as Error)?.message ?? 'Could not load' }])));
    });
    return () => { ignore = true; };
  }, [keyList]);
  return lists;
}

/** Choose the skills, docs, MCP servers, plugins and notification channels an agent launches with. */
export function LoadoutPicker({ vendor, value, onChange, sections = ALL_SECTIONS }: LoadoutPickerProps) {
  const sectionList = sections.join(',');
  const keys = useMemo(() => ALL_SECTIONS.filter((key) => sectionList.split(',').includes(key)), [sectionList]);
  const lists = useSectionLists(keys);
  const latest = useRef({ value, onChange });
  useEffect(() => { latest.current = { value, onChange }; });

  // Once a list has loaded, forget selections that no longer exist (or are always on anyway).
  useEffect(() => {
    const { value: current, onChange: emit } = latest.current;
    const next = keys.reduce<LaunchLoadout>((acc, key) => {
      const state = lists[key];
      const selected = acc[key];
      if (state?.status !== 'ready' || !selected?.length) return acc;
      const selectable = new Set(state.options.filter((o) => !o.lockedOn).map((o) => o.id));
      const kept = selected.filter((id) => selectable.has(id));
      return kept.length === selected.length ? acc : withSection(acc, key, kept);
    }, current);
    if (next !== current) emit(next);
  }, [lists, keys]);

  return (
    <div className="loadout">
      <p className="loadout-summary" aria-live="polite">{summarize(value, vendor === 'codex' ? keys.filter((key) => key !== 'pluginIds') : keys)}</p>
      {keys.map((key) => (
        <LoadoutSectionView
          key={key}
          sectionKey={key}
          state={lists[key] ?? { status: 'loading' }}
          selected={value[key] ?? []}
          disabledNote={key === 'pluginIds' && vendor === 'codex' ? 'Plugins are Claude-only, so Codex agents launch without them.' : undefined}
          onChange={(ids) => onChange(withSection(value, key, ids))}
        />
      ))}
    </div>
  );
}

function summarize(value: LaunchLoadout, keys: readonly LoadoutSection[]): string {
  const parts = keys.flatMap((key) => {
    const count = value[key]?.length ?? 0;
    const [one, many] = SECTION_META[key].noun;
    return count ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return parts.length ? `Selected: ${parts.join(' · ')}` : 'Nothing extra selected.';
}

interface LoadoutSectionViewProps {
  readonly sectionKey: LoadoutSection;
  readonly state: SectionState;
  readonly selected: readonly string[];
  readonly disabledNote?: string;
  readonly onChange: (ids: readonly string[]) => void;
}

function LoadoutSectionView({ sectionKey, state, selected, disabledNote, onChange }: LoadoutSectionViewProps) {
  const meta = SECTION_META[sectionKey];
  const captionId = useId();
  const [query, setQuery] = useState('');
  const options = state.status === 'ready' ? state.options : [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.title} ${o.detail ?? ''} ${o.tag ?? ''}`.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));

  return (
    <fieldset className="loadout-section" disabled={!!disabledNote} aria-describedby={captionId}>
      <legend>{meta.legend}{selected.length > 0 && <span className="loadout-count">{selected.length}</span>}</legend>
      <p className="loadout-caption" id={captionId}>{disabledNote ?? meta.caption}</p>
      {state.status === 'loading' && <p className="loadout-note">Loading…</p>}
      {state.status === 'error' && <p className="loadout-note">Not available yet. ({state.message})</p>}
      {state.status === 'ready' && options.length === 0 && <p className="loadout-note">{meta.empty}</p>}
      {options.length > SEARCH_THRESHOLD && (
        <input className="text-input loadout-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${options.length} ${meta.noun[1]}…`} aria-label={`Search ${meta.legend.toLowerCase()}`} />
      )}
      {options.length > 0 && (
        <ul className="loadout-list">
          {visible.map((option) => (
            <li key={option.id}>
              <label className="loadout-option">
                <input type="checkbox" checked={!!option.lockedOn || selected.includes(option.id)} disabled={!!option.lockedOn}
                  onChange={(e) => toggle(option.id, e.target.checked)} />
                <span className="loadout-option-text">
                  <span className="loadout-option-title">{option.title}</span>
                  {(option.lockedOn || option.detail) && <span className="loadout-option-detail">{option.lockedOn ?? option.detail}</span>}
                </span>
                {option.tag && <span className="loadout-tag">{option.tag}</span>}
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="loadout-note">No matches.</li>}
        </ul>
      )}
    </fieldset>
  );
}
