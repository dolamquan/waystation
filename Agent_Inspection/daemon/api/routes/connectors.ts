import type { Tower } from '../../tower.ts';
import { LibraryInputError } from '../../library/types.ts';
import { connectorRpc } from '../../connectors/rpc.ts';
import { bodyOf, headerOf, r, type Route } from './route.ts';
import type { IncomingMessage } from 'node:http';

const localEndpoint = (req: IncomingMessage) => `http://127.0.0.1:${req.socket.localPort}`;
const callback = (req: IncomingMessage) => `http://localhost:${req.socket.localPort}/agent/connectors/oauth/callback`;
export function connectorRoutes(tower: Tower): Route[] {
  const broker = tower.library.connectors;
  return [
    r('GET', '/api/connectors', ({ req }) => ({ ...broker.state(new URL(req.url!, 'http://localhost').searchParams.get('project')), redirectUri: callback(req) })),
    r('POST', '/api/connectors/accounts', ({ body, req }) => broker.connect(bodyOf(body), callback(req))),
    r('POST', '/api/connectors/oauth/complete', async ({ body }) => {
      let url: URL; try { url = new URL(String(bodyOf(body).callbackUrl)); } catch { throw new LibraryInputError('Paste the full redirect URL from your sign-in tab.'); }
      return { account: await broker.complete(url) };
    }),
    r('POST', '/api/connectors/accounts/:id/disconnect', ({ params }) => { broker.disconnect(params[0]); return { ok: true }; }),
    r('POST', '/api/connectors/accounts/:id/remove', ({ params }) => { broker.removeAccount(params[0]); return { ok: true }; }),
    r('POST', '/api/connectors/grants', ({ body, req }) => {
      const raw = bodyOf(body); const architectures = tower.library.automation.architectures;
      const doc = architectures.get(raw.architectureId).document;
      if (raw.expectedRevision !== doc.revision) throw new LibraryInputError('The workflow changed. Refresh it before granting access.');
      const { grant, token } = broker.createGrant(raw, doc);
      const capabilities: { id: string; version: number }[] = []; let credentialId: string | undefined; let mcpId: string | undefined;
      const url = `${localEndpoint(req)}/agent/connectors/mcp`;
      try {
        credentialId = tower.library.resources.storeCredential(doc.project, 'authorization', `Bearer ${token}`);
        for (const t of broker.tools(grant)) {
          const cap = tower.library.agentPlatform.saveCapability(doc.project, { name: `${grant.agentName} · ${t.label}`, description: `${t.description} Connected app access; grant ${grant.id}. ${t.write && grant.requireApproval ? 'Requires operator approval in App access.' : ''}`, spec: { kind: 'tool', config: { type: 'tool', implementation: 'http', functionName: `${t.name}_${grant.id.slice(0, 8)}`, inputSchema: t.inputSchema, method: 'POST', url: `${localEndpoint(req)}/agent/connectors/call/${t.name}`, timeoutMs: 30000, credentialId } } });
          capabilities.push({ id: cap.id, version: cap.version });
        }
        const node = doc.nodes.find(n => n.id === grant.nodeId)!;
        if ((node.capabilities?.length ?? 0) + capabilities.length > 30) throw new LibraryInputError('This agent would exceed 30 capabilities. Remove a capability first.');
        const server = tower.library.mcp.registerConnector(grant.id, `${grant.agentName} · app access`, url, token); mcpId = server.id;
        const snapshot = architectures.update(doc.id, raw.expectedRevision, [{ type: 'put_node', node: { ...node, capabilities: [...(node.capabilities ?? []), ...capabilities] } }]);
        return { grant, snapshot, mcpId, mcpConfig: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }, message: 'Tools attached to the draft. Deploy a new version to use them in a deployed agent. Existing deployments keep their capability versions.' };
      } catch (e) {
        broker.revoke(grant.id);
        for (const c of capabilities) tower.store.deleteRecord('agent_capabilities', c.id);
        if (credentialId) { tower.library.deps.secrets.deleteUnder(`architecture-resource:${credentialId}:`); tower.store.deleteRecord('architecture_credentials', credentialId); }
        if (mcpId) tower.library.mcp.remove(mcpId);
        throw e;
      }
    }),
    r('POST', '/api/connectors/grants/:id/revoke', ({ params }) => { broker.revoke(params[0]); return { ok: true }; }),
    r('POST', '/api/connectors/approvals/:id', async ({ params, body }) => {
      const approve = bodyOf(body).approve;
      if (typeof approve !== 'boolean') throw new LibraryInputError('Choose approve or deny.');
      return broker.decide(params[0], approve);
    }),
  ];
}

/** These routes use OAuth state or an independent grant token; the operator API token is never given to agents. */
export function connectorBridgeRoutes(tower: Tower): Route[] {
  const broker = tower.library.connectors;
  return [
    r('GET', '/agent/connectors/oauth/callback', async ({ req, res }) => {
      // The browser carries a single-use state. No HTML from providers is reflected into this page.
      let ok = true;
      try { await broker.complete(new URL(req.url!, callback(req))); } catch { ok = false; }
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      res.end(ok ? '<!doctype html><title>Account connected</title><h1>Account connected</h1><p>Close this tab and return to App access in Waystation to grant tools to an agent.</p>' : '<!doctype html><title>Sign-in incomplete</title><h1>Sign-in incomplete</h1><p>Return to App access in Waystation and start the connection again.</p>');
    }),
    r('POST', '/agent/connectors/mcp', async ({ req, res, body }) => {
      const grant = broker.authenticate(headerOf(req, 'authorization'));
      if (!headerOf(req, 'content-type')?.startsWith('application/json')) throw new LibraryInputError('MCP requires application/json.');
      const result = await connectorRpc(broker, grant, body);
      if (result === undefined) { res.writeHead(204); res.end(); }
      return result;
    }),
    r('POST', '/agent/connectors/call/:tool', async ({ req, body }) => {
      const grant = broker.authenticate(headerOf(req, 'authorization'));
      const name = new URL(req.url!, 'http://localhost').pathname.split('/').at(-1)!;
      return broker.invoke(grant, name, body);
    }),
  ];
}
