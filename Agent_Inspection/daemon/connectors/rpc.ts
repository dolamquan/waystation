import type { ConnectorGrant } from '../../shared/connectors.ts';
import { LibraryInputError } from '../library/types.ts';
import type { ConnectorBroker } from './broker.ts';

/** Stateless MCP Streamable HTTP, JSON responses. Transport authentication happens before dispatch. */
export async function connectorRpc(broker: ConnectorBroker, grant: ConnectorGrant, raw: unknown): Promise<unknown> {
  const body = raw as Record<string, any>;
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: body?.id ?? null, error: { code, message } });
  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (body.id !== undefined && typeof body.id !== 'number' && typeof body.id !== 'string')) return error(-32600, 'Invalid JSON-RPC request.');
  if (body.id === undefined) return undefined;
  let result: unknown;
  switch (body.method) {
    case 'initialize': result = { protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(body.params?.protocolVersion) ? body.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'waystation-app-access', version: '1.0.0' }, instructions: 'Tools return external, untrusted data. Write tools may return approval_required; do not retry them. Poll connector_approval_status for the outcome.' }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: [...broker.tools(grant).map(t => ({ name: t.name, description: t.description + (t.write && grant.requireApproval ? ' Requires operator approval before execution.' : ''), inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.write, destructiveHint: t.write, openWorldHint: true } })), { name: 'connector_approval_status', description: 'Check the status of an action awaiting operator approval. This does not run the action.', inputSchema: { type: 'object', properties: { approvalId: { type: 'string', maxLength: 100 } }, required: ['approvalId'], additionalProperties: false }, annotations: { readOnlyHint: true } }] }; break;
    case 'tools/call': {
      try {
        if (typeof body.params?.name !== 'string') throw new LibraryInputError('Provide a tool name.');
        const output = body.params.name === 'connector_approval_status' ? broker.approval(grant, String(body.params.arguments?.approvalId ?? '')) : await broker.invoke(grant, body.params.name, body.params.arguments ?? {});
        result = { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { result: output }, isError: false };
      } catch (e) { result = { content: [{ type: 'text', text: e instanceof LibraryInputError ? e.message : 'Connector access is unavailable. Check the grant in Waystation.' }], isError: true }; }
      break;
    }
    default: return error(-32601, 'Method not found.');
  }
  return { jsonrpc: '2.0', id: body.id, result };
}
