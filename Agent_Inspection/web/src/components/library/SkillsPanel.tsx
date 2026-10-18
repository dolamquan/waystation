import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { skillsApi, type LibrarySkill, type LibrarySkillDetail } from '../../library/skillsApi.ts';
import '../../library/skills.css';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { PanelEmpty } from '../SectionTabs.tsx';
import type { LibraryPanelProps } from './LibraryView.tsx';

type SourceFilter = 'all' | 'waystation' | 'user' | 'plugin';

const FILTERS: ReadonlyArray<{ readonly id: SourceFilter; readonly label: string }> = [
  { id: 'all', label: 'All sources' },
  { id: 'waystation', label: 'Made in Waystation' },
  { id: 'user', label: 'Your local skills' },
  { id: 'plugin', label: 'From plugins' },
];

type Selection =
  | { readonly mode: 'new' }
  | { readonly mode: 'open'; readonly skill: LibrarySkillDetail };

const sourceText = (source: string): string => {
  if (source === 'waystation') return 'Waystation';
  if (source === 'user') return 'Local skill';
  return source.startsWith('plugin:') ? `Plugin: ${source.slice(7)}` : source;
};

const matchesFilter = (skill: LibrarySkill, filter: SourceFilter): boolean =>
  filter === 'all' || (filter === 'plugin' ? skill.source.startsWith('plugin:') : skill.source === filter);

const matchesQuery = (skill: LibrarySkill, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return !needle || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(needle);
};

/** Create and edit skills; browse the ones Claude Code already has. */
export function SkillsPanel({ notify }: LibraryPanelProps) {
  const [skills, setSkills] = useState<readonly LibrarySkill[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [selection, setSelection] = useState<Selection>();
  const [deleting, setDeleting] = useState<LibrarySkill>();

  const load = useCallback(async () => {
    try {
      setSkills((await skillsApi.list()).skills);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => skills.filter((s) => matchesFilter(s, filter) && matchesQuery(s, query)), [skills, filter, query]);

  const open = async (id: string) => {
    try {
      setSelection({ mode: 'open', skill: (await skillsApi.get(id)).skill });
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const saved = async (skill: LibrarySkillDetail, message: string) => {
    notify(message);
    setSelection({ mode: 'open', skill });
    await load();
  };

  const duplicate = async (skill: LibrarySkill) => {
    try {
      const copy = (await skillsApi.duplicate(skill.id)).skill;
      await saved(copy, `Copied as ${copy.name}. You can edit it now.`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const remove = async (skill: LibrarySkill) => {
    try {
      await skillsApi.remove(skill.id);
      notify(`Deleted ${skill.name}`);
      if (selection?.mode === 'open' && selection.skill.id === skill.id) setSelection(undefined);
      await load();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const selectedId = selection?.mode === 'open' ? selection.skill.id : undefined;

  return (
    <section className="ops-section skills-panel" aria-labelledby="skills-heading">
      <div className="section-heading">
        <div>
          <h2 id="skills-heading">Skills</h2>
          <p>Instructions you can keep and use again, from code reviews to release notes.</p>
        </div>
        <button className="btn btn-go" onClick={() => setSelection({ mode: 'new' })}><Icon name="plus" size={15} />New skill</button>
      </div>

      {error && <div className="detail-load-error" role="alert"><p>Couldn’t load skills. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}

      <div className="skills-toolbar">
        <label className="skills-search">
          <span className="sr-only">Search skills</span>
          <Icon name="search" size={14} />
          <input className="text-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" />
        </label>
        <label>
          <span className="sr-only">Filter by source</span>
          <select className="text-input" value={filter} onChange={(e) => setFilter(e.target.value as SourceFilter)}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      </div>

      <div className="skills-layout">
        <div className="skills-list-wrap">
          {loading && <p role="status" className="workspace-loading">Loading skills…</p>}
          {!loading && !error && <p className="resource-count">{visible.length} of {skills.length} skills</p>}
          {!loading && !error && visible.length === 0 && <PanelEmpty icon={skills.length ? 'search' : 'sparkle'} title={skills.length ? 'No matching skills' : 'Teach your agent a new skill'}><p>{skills.length ? 'Try another search or source.' : 'Save instructions once and reuse them across tasks.'}</p>{skills.length ? <button className="btn" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button> : <button className="btn" onClick={() => setSelection({ mode: 'new' })}>Create a skill</button>}</PanelEmpty>}
          <ul className="ops-list skills-list" aria-label="Skills">
            {visible.map((skill) => (
              <li key={skill.id} className={`ops-row skills-row${skill.id === selectedId ? ' skills-row-on' : ''}`}>
                <button className="skills-row-open" onClick={() => void open(skill.id)} aria-current={skill.id === selectedId ? 'true' : undefined}>
                  <strong>{skill.name}</strong>
                  <small>{skill.description || 'No description'}</small>
                  <span className="skills-source">{sourceText(skill.source)}{skill.editable ? '' : ' · read-only'}</span>
                </button>
                {skill.editable && (
                  <button className="icon-btn" aria-label={`Delete ${skill.name}`} title="Delete" onClick={() => setDeleting(skill)}><Icon name="close" size={14} /></button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="skills-detail">
          {!selection && <PanelEmpty icon="book" title="Pick a skill from the shelf"><p>Its instructions will open here. Edit your own skills, or make a copy of a plugin skill.</p></PanelEmpty>}
          {selection?.mode === 'new' && (
            <SkillForm key="new" onCancel={() => setSelection(undefined)} onSaved={(skill) => void saved(skill, `Created ${skill.name}`)} notify={notify} />
          )}
          {selection?.mode === 'open' && selection.skill.editable && (
            <SkillForm key={selection.skill.id} skill={selection.skill} onCancel={() => setSelection(undefined)} onSaved={(skill) => void saved(skill, `Saved ${skill.name}`)} notify={notify} />
          )}
          {selection?.mode === 'open' && !selection.skill.editable && (
            <SkillReader skill={selection.skill} onDuplicate={() => void duplicate(selection.skill)} onClose={() => setSelection(undefined)} />
          )}
        </div>
      </div>

      <AnimatePresence>
        {deleting && (
          <Confirm
            title={`Delete ${deleting.name}?`}
            body="Agents already running with this skill keep their copy. New agents can no longer be given it."
            confirmLabel="Delete"
            danger
            onConfirm={() => void remove(deleting)}
            onClose={() => setDeleting(undefined)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

interface SkillFormProps {
  readonly skill?: LibrarySkillDetail;
  readonly onSaved: (skill: LibrarySkillDetail) => void;
  readonly onCancel: () => void;
  readonly notify: LibraryPanelProps['notify'];
}

function SkillForm({ skill, onSaved, onCancel, notify }: SkillFormProps) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = skill
        ? await skillsApi.update(skill.id, { description, body })
        : await skillsApi.create({ name, description, body });
      onSaved(result.skill);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form ops-form skills-form" onSubmit={(e) => void submit(e)} aria-label={skill ? `Edit ${skill.name}` : 'New skill'}>
      <h3>{skill ? `Edit ${skill.name}` : 'New skill'}</h3>
      {skill ? (
        <p className="skills-hint">Name: <code>{skill.name}</code> (fixed once created)</p>
      ) : (
        <label>Name<input className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required placeholder="e.g. release-notes" aria-describedby="skill-name-hint" />
          <small id="skill-name-hint" className="skills-hint">Saved in lowercase with hyphens, e.g. “Release Notes” becomes release-notes.</small>
        </label>
      )}
      <label>Description<input className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} required placeholder="When should the agent use this skill?" /></label>
      <label>Instructions (Markdown)
        <textarea className="text-input skills-body" value={body} onChange={(e) => setBody(e.target.value)} rows={16} required spellCheck={false} placeholder={'# How to …\n\n1. …'} />
      </label>
      <div className="skills-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={busy}>{busy ? 'Saving…' : skill ? 'Save changes' : 'Create skill'}</button>
      </div>
    </form>
  );
}

interface SkillReaderProps {
  readonly skill: LibrarySkillDetail;
  readonly onDuplicate: () => void;
  readonly onClose: () => void;
}

function SkillReader({ skill, onDuplicate, onClose }: SkillReaderProps) {
  return (
    <article className="ops-form skills-reader" aria-label={skill.name}>
      <header className="skills-reader-head">
        <div>
          <h3>{skill.name}</h3>
          <small className="skills-source">{sourceText(skill.source)} · read-only</small>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      </header>
      {skill.description && <p>{skill.description}</p>}
      <pre className="code-view skills-body-view">{skill.body || '(empty)'}</pre>
      <div className="skills-form-actions">
        <button className="btn" onClick={onDuplicate}><Icon name="copy" size={14} />Duplicate to edit</button>
      </div>
    </article>
  );
}
