import { useEffect, useRef, useState } from 'react';
import { api, type AgentTemplate } from '../api.ts';
import type { LaunchLoadout } from '../library/loadoutApi.ts';
import type { Vendor } from '../models.ts';
import { LoadoutPicker, defaultLoadout, isLoadoutEmpty } from './LoadoutPicker.tsx';
import { Modal } from './Modal.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { ProjectFolderInput } from './ProjectFolderInput.tsx';
import { useToolAvailability } from '../useToolAvailability.ts';

/** Plugins are Claude-only, so a Codex launch never carries them. */
function launchLoadout(loadout: LaunchLoadout, vendor: Vendor): LaunchLoadout | undefined {
  const { pluginIds, ...rest } = loadout;
  const forVendor = vendor === 'claude' && pluginIds ? { ...rest, pluginIds } : rest;
  return isLoadoutEmpty(forVendor) ? undefined : forVendor;
}

interface NewAgentDialogProps {
  readonly defaultCwd?: string;
  readonly onClose: () => void;
  readonly onLaunched: (agentId: string) => void;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

export function NewAgentDialog({ defaultCwd, onClose, onLaunched, notify }: NewAgentDialogProps) {
  const tools = useToolAvailability();
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [intercept, setIntercept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [saveLabel, setSaveLabel] = useState<string>();
  const [loadout, setLoadout] = useState<LaunchLoadout>({});
  /** Set once a template has filled the loadout, so late-arriving defaults don't overwrite it. */
  const loadoutChosen = useRef(false);

  useEffect(() => {
    let ignore = false;
    api.templates().then(({ templates: list }) => { if (!ignore) setTemplates(list); }, () => undefined);
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    let ignore = false;
    void defaultLoadout().then((defaults) => {
      if (!ignore && !loadoutChosen.current) setLoadout((current) => (isLoadoutEmpty(current) ? defaults : current));
    });
    return () => { ignore = true; };
  }, []);

  const chooseVendor = (next: Vendor) => {
    // A Claude model name means nothing to Codex (and vice versa), so don't carry it across.
    if (next !== vendor) setModel('');
    setVendor(next);
  };

  /** A template only fills in the form; nothing launches until you press Launch. */
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    setVendor(template.vendor);
    setModel(template.model ?? '');
    setName(template.agentName ?? '');
    setInstructions(template.instructions ?? '');
    setIntercept(template.intercept);
    setLoadout(template.loadout ?? {});
    loadoutChosen.current = true;
    if (template.prompt && !prompt.trim()) setPrompt(template.prompt);
  };

  const saveTemplate = async () => {
    const label = saveLabel?.trim();
    if (!label) return;
    try {
      const { template } = await api.createTemplate({
        label,
        vendor,
        model: model.trim() || undefined,
        agentName: name.trim() || undefined,
        instructions: instructions.trim() || undefined,
        prompt: prompt.trim() || undefined,
        intercept: vendor === 'claude' && intercept,
        loadout: launchLoadout(loadout, vendor),
      });
      setTemplates((list) => [...list, template]);
      setTemplateId(template.id);
      setSaveLabel(undefined);
      notify(`Saved template ${template.label}`);
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { agent } = await api.launch({
        vendor,
        cwd: cwd.trim(),
        prompt,
        name: name.trim() || undefined,
        model: model.trim() || undefined,
        appendSystemPrompt: instructions.trim() || undefined,
        intercept: vendor === 'claude' && intercept,
        loadout: launchLoadout(loadout, vendor),
      });
      notify(`Launched ${agent.name}`);
      onLaunched(agent.id);
      onClose();
    } catch (error) {
      notify((error as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Launch a new agent" onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        {templates.length > 0 && (
          <label>Start from a template
            <select className="text-input" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Blank</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        )}
        <div className="segmented" role="radiogroup" aria-label="Agent type">
          {(['claude', 'codex'] as const).map((v) => (
            <button type="button" key={v} role="radio" aria-checked={vendor === v} disabled={v === 'codex' && tools.codex === false} className={vendor === v ? 'seg-on' : ''} onClick={() => chooseVendor(v)}>
              {v === 'claude' ? 'Claude (Agent SDK)' : 'Codex (codex exec)'}
            </button>
          ))}
        </div>
        {tools.codex === false && <p className="muted">Codex CLI was not found. Install it or configure its path in Desktop setup to launch Codex agents.</p>}
        <div className="form-pair">
          <label>Name
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Test fixer" />
          </label>
          <div className="form-field">
            <span>Model</span>
            <ModelPicker key={`${vendor}:${templateId}`} vendor={vendor} value={model} onChange={setModel} />
          </div>
        </div>
        <ProjectFolderInput value={cwd} onChange={setCwd} />
        <label>Task
          <textarea className="text-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} required placeholder="What should this agent do?" />
        </label>
        <details className="form-more" open={instructions.length > 0}>
          <summary>Role instructions (optional)</summary>
          <textarea
            className="text-input"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            maxLength={8000}
            placeholder="Standing instructions for this agent, e.g. “You review code. Never edit files; report findings.”"
            aria-label="Role instructions"
          />
        </details>
        <details className="form-more" open={!isLoadoutEmpty(loadout)}>
          <summary>Skills, docs &amp; tools (optional)</summary>
          <LoadoutPicker vendor={vendor} value={loadout} onChange={setLoadout} />
        </details>
        {vendor === 'claude' && (
          <label className="check">
            <input type="checkbox" checked={intercept} onChange={(e) => setIntercept(e.target.checked)} />
            Start in Intercept mode (approve each tool call that needs permission)
          </label>
        )}
        {saveLabel !== undefined && (
          <div className="form-inline">
            <input className="text-input" value={saveLabel} onChange={(e) => setSaveLabel(e.target.value)} maxLength={60} placeholder="Template name, e.g. Reviewer on Haiku" aria-label="Template name" autoFocus />
            <button type="button" className="btn btn-small" onClick={() => void saveTemplate()} disabled={!saveLabel.trim()}>Save</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSaveLabel(undefined)}>Cancel</button>
          </div>
        )}
        <footer className="modal-foot">
          {saveLabel === undefined && <button type="button" className="btn btn-ghost modal-foot-left" onClick={() => setSaveLabel('')}>Save as template</button>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-go" disabled={busy || (vendor === 'codex' && tools.codex === false)}>{busy ? 'Launching…' : 'Launch'}</button>
        </footer>
      </form>
    </Modal>
  );
}
