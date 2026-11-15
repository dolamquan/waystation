import { useState } from 'react';
import type { FactoryDefinition, FactoryRoleName } from '../../../../shared/factory.ts';
import { useProviders } from '../../useProviders.ts';
import { factoryApi } from './api.ts';
import { FactoryWorkflow } from './FactoryWorkflow.tsx';

export type FactoryTab = 'overview' | 'work' | 'agents' | 'workflows' | 'quality' | 'settings';
export function FactoryEditor({ factory, tab, onSaved }: { factory: FactoryDefinition; tab: FactoryTab; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => structuredClone(factory));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState('');
  const { providers } = useProviders();
  const edit = (next: FactoryDefinition) => { setDraft(next); setSaved(''); };
  const role = (name: FactoryRoleName, patch: Partial<FactoryDefinition['roles'][FactoryRoleName]>) => edit({ ...draft, roles: { ...draft.roles, [name]: { ...draft.roles[name], ...patch } } });
  return <form className="factory-editor" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved('');
    void factoryApi.save(draft, factory.id).then(async ({ factory: next }) => { setDraft(next); await onSaved(); setSaved('Saved. New work items will use this configuration.'); })
      .catch(error => setError(error.message)).finally(() => setBusy(false));
  }}>
    {tab === 'agents' && <>
      <div className="factory-section-head"><div><h2>Your factory crew</h2><p>Reusable roles, each with its own provider, model and instructions.</p></div></div>
      <div className="factory-role-grid">{(['planner', 'builder', 'reviewer'] as const).map((name, index) => <fieldset className="factory-role" key={name}>
        <legend><span>{String(index + 1).padStart(2, '0')}</span> {name[0].toUpperCase() + name.slice(1)}</legend>
        <p>{name === 'planner' ? 'Investigates the request and proposes a plan for your approval.' : name === 'builder' ? 'Implements changes in the work item’s isolated Git worktree.' : 'Reviews the tested candidate. Findings remain visible for your acceptance.'}</p>
        <label>Provider<select aria-label="Provider" value={draft.roles[name].vendor} onChange={event => role(name, { vendor: event.target.value })}>
          {!providers.some(provider => provider.id === draft.roles[name].vendor) && <option value={draft.roles[name].vendor}>{draft.roles[name].vendor}</option>}
          {providers.map(provider => <option value={provider.id} key={provider.id}>{provider.label}{provider.available === false ? ' (unavailable)' : ''}</option>)}
        </select></label>
        <label>Model<input value={draft.roles[name].model} onChange={event => role(name, { model: event.target.value })} maxLength={150} placeholder="Provider default" /></label>
        <label>Instructions<textarea aria-label="Instructions" value={draft.roles[name].instructions} onChange={event => role(name, { instructions: event.target.value })} rows={5} maxLength={6000} /></label>
      </fieldset>)}</div>
      <p className="factory-note">Plan and review roles run when enabled in Workflows. Provider sign-in and tool permissions use your existing Waystation setup.</p>
    </>}
    {tab === 'workflows' && <>
      <div className="factory-section-head"><div><h2>How work moves</h2><p>Define the process once. Every work item keeps its own version.</p></div></div>
      <FactoryWorkflow definition={draft} />
      <p className="factory-note">This diagram previews the settings below. Save the configuration to apply it to new work.</p>
      <div className="factory-form-grid">
        <label>Workflow name<input required maxLength={100} value={draft.workflow.name} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, name: event.target.value } })} /></label>
        <label>Automatic repair attempts<input type="number" min={0} max={5} required value={draft.workflow.maxRepairs} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, maxRepairs: Number(event.target.value) } })} /></label>
        <label>Time limit per stage / check (minutes)<input type="number" min={1} max={120} required value={draft.workflow.maxMinutes} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, maxMinutes: Number(event.target.value) } })} /></label>
      </div>
      <label className="factory-checkbox"><input type="checkbox" checked={draft.workflow.requirePlan} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, requirePlan: event.target.checked } })} />Require a plan and your approval before building</label>
      <label className="factory-checkbox"><input type="checkbox" checked={draft.workflow.review} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, review: event.target.checked } })} />Run an agent review after checks pass</label>
      <div className="factory-section-head"><div><h3>Required checks</h3><p>Commands run in the worktree using your local shell. Configure the project’s actual build and test commands.</p></div><button className="btn btn-small" type="button" disabled={draft.workflow.checks.length >= 12} onClick={() => edit({ ...draft, workflow: { ...draft.workflow, checks: [...draft.workflow.checks, { id: crypto.randomUUID(), name: '', command: '' }] } })}>Add check</button></div>
      {draft.workflow.checks.length === 0 && <p className="factory-callout">Add at least one meaningful check before creating work. A successful agent turn alone does not satisfy validation.</p>}
      {draft.workflow.checks.map((check, index) => <div className="factory-check-editor" key={check.id}>
        <label>Check name<input required value={check.name} maxLength={100} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, checks: draft.workflow.checks.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) } })} placeholder="Regression tests" /></label>
        <label>Command<input required value={check.command} maxLength={2000} onChange={event => edit({ ...draft, workflow: { ...draft.workflow, checks: draft.workflow.checks.map((entry, i) => i === index ? { ...entry, command: event.target.value } : entry) } })} placeholder="npm test" /></label>
        <button type="button" className="btn btn-small" aria-label={`Remove check ${index + 1}`} onClick={() => edit({ ...draft, workflow: { ...draft.workflow, checks: draft.workflow.checks.filter((_, i) => i !== index) } })}>Remove</button>
      </div>)}
      <p className="factory-note">Acceptance and merging always require your explicit action. Scheduling and event triggers can be added in a later version.</p>
    </>}
    {tab === 'settings' && <>
      <div className="factory-section-head"><div><h2>Factory settings</h2><p>Shared context and repository defaults for future work.</p></div><span className="factory-badge">Configuration v{factory.revision}</span></div>
      <div className="factory-form-grid"><label>Factory name<input required maxLength={100} value={draft.name} onChange={event => edit({ ...draft, name: event.target.value })} /></label>
        <label>Repository path<input required maxLength={2000} value={draft.repository} onChange={event => edit({ ...draft, repository: event.target.value })} /></label></div>
      <label>Project context<textarea rows={8} maxLength={6000} value={draft.context} onChange={event => edit({ ...draft, context: event.target.value })} placeholder="Architecture, conventions and constraints each role should know." /></label>
      <p className="factory-note">Work starts from the repository’s latest committed revision. Uncommitted changes stay in your checkout. Each work item preserves its original settings, branch and evidence.</p>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
    <footer className="factory-form-footer"><span>Changes apply to new work items.</span><button className="btn btn-go" disabled={busy}>{busy ? 'Saving…' : 'Save configuration'}</button></footer>
  </form>;
}
