import { useEffect, useState } from 'react';
import type { ArchitectureNode } from '../../../../shared/architecture.ts';
import type { AgentDeployment, AgentPlatformState } from '../../../../shared/agentPlatform.ts';
import type { ToolManifestEntry } from '../../../../shared/agentRuns.ts';
import { request } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { capName } from './AgentPlatform.tsx';
import { ToolsTheModelSees } from './AgentTools.tsx';

const enc = encodeURIComponent;
/** The deployment preview refuses an agent whose tools are attached while its tool access is chat-only. */
export const isChatOnlyRefusal = (message: string | undefined): boolean => !!message && /tool access is "Chat only"/i.test(message);

interface Preview { key: string; tools?: ToolManifestEntry[]; error?: string }

/** Draft bindings refer to immutable published versions, never latest implicitly. */
export function AgentDeploymentControls({ node, documentId, revision, project, dirty, save, onDeployment, onLibrary, onPreviewError }: {
  node: ArchitectureNode; documentId: string; revision: number; project: string; dirty: boolean;
  save: (node: ArchitectureNode) => Promise<boolean>; onDeployment: (id: string) => void; onLibrary: () => void; onPreviewError?: (message: string) => void;
}) {
  const [state, setState] = useState<AgentPlatformState>(); const [environmentId, setEnvironmentId] = useState(''); const [capabilityId, setCapabilityId] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => { let active = true; void request<AgentPlatformState>('GET', `/api/agent-platform?project=${enc(project)}`).then(next => { if (active) { setState(next); setEnvironmentId(next.environments[0]?.id ?? ''); } }, e => { if (active) setError((e as Error).message); }); return () => { active = false; }; }, [project]);
  const hasRuntime = !!node.runtime;
  const previewKey = `${documentId}:${node.id}:${revision}:${environmentId}`;
  // Preview the saved draft whenever it or the environment changes: the same checks and tool list a deploy would use.
  useEffect(() => {
    if (!environmentId || !hasRuntime || dirty) return;
    let active = true;
    void request<{ tools: ToolManifestEntry[] }>('POST', `/api/architectures/${enc(documentId)}/nodes/${enc(node.id)}/deployment-preview`, { environmentId })
      .then(result => { if (active) setPreview({ key: previewKey, tools: result.tools }); }, e => { if (active) setPreview({ key: previewKey, error: (e as Error).message }); });
    return () => { active = false; };
  }, [previewKey, environmentId, hasRuntime, dirty, documentId, node.id]);
  const currentPreview = preview?.key === previewKey ? preview : undefined;
  const previewError = currentPreview?.error ?? '';
  useEffect(() => { onPreviewError?.(previewError); }, [previewError, onPreviewError]);

  const attach = async () => { const capability = state?.capabilities.find(c => c.id === capabilityId); if (!capability) return; setBusy(true); setError(''); try { await save({ ...node, capabilities: [...(node.capabilities ?? []).filter(c => c.id !== capability.id), { id: capability.id, version: capability.version }] }); setCapabilityId(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const deploy = async () => { setBusy(true); setError(''); try { const result = await request<{ deployment: AgentDeployment }>('POST', `/api/architectures/${enc(documentId)}/nodes/${enc(node.id)}/deploy`, { expectedRevision: revision, environmentId }); onDeployment(result.deployment.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const showPreview = hasRuntime && !dirty && !!environmentId;
  return <section className="platform-draft-deployment" aria-label="Agent capabilities and deployment"><h3>Capabilities & deployment</h3><p>Attach reusable versions, then deploy the saved agent. Each deploy creates a candidate version; promote it to production from Agents once it passes its release policy.</p>
    <ul className="platform-bindings">{node.capabilities?.map(ref => { const cap = state?.capabilities.find(c => c.id === ref.id); return <li key={ref.id}><span>{cap?.name ?? ref.id} · v{ref.version}{cap && cap.version > ref.version ? ` · v${cap.version} available` : ''}</span><button className="btn btn-small" disabled={busy || dirty} onClick={() => { void save({ ...node, capabilities: node.capabilities!.filter(c => c.id !== ref.id) }); }}>Detach</button></li>; })}</ul>
    <div className="platform-binding-actions"><label>Published capability<select aria-label="Published capability" className="text-input" value={capabilityId} onChange={e => setCapabilityId(e.target.value)}><option value="">Choose a capability</option>{state?.capabilities.map(c => <option key={c.id} value={c.id}>{c.name} · v{c.version} · {capName(c)}</option>)}</select></label><button className="btn btn-small" disabled={!capabilityId || dirty || busy} onClick={() => { void attach(); }}>Attach version</button><button className="btn btn-small" onClick={onLibrary}>Manage capabilities</button></div>
    <div className="platform-binding-actions"><label>Deployment environment<select aria-label="Deployment environment" className="text-input" value={environmentId} onChange={e => setEnvironmentId(e.target.value)}>{state?.environments.map(env => <option key={env.id} value={env.id}>{env.name} · local server{env.sandbox ? ' · code execution' : ''}</option>)}</select></label><button className="btn btn-go" disabled={busy || dirty || !node.runtime || !environmentId || !!previewError} onClick={() => { void deploy(); }}><Icon name="play" size={14} />{busy ? 'Preparing…' : 'Deploy as candidate'}</button></div>
    {showPreview && <ToolsTheModelSees tools={currentPreview?.tools} loading={!currentPreview} error={isChatOnlyRefusal(previewError) ? 'Attached tools are hidden from the model because tool access is “Conversation only”. Change Tool access above, or detach the tools.' : previewError} />}
    {!hasRuntime && <p className="platform-help">Save the agent with a brain to preview its tools and deploy it.</p>}
    {dirty && <p className="platform-help">Save agent changes before attaching capabilities, previewing tools or deploying.</p>}{error && <p className="arch-error" role="alert">{error}</p>}</section>;
}
