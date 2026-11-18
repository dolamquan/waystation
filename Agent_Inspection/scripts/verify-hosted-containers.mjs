/** Run inside the gateway container after starting only the private gateway/worker services.
 * Uses the generated example membership and creates an explicitly named smoke-test workflow/credential.
 * No model request, real account credential, public port or identity-provider connection is used.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
const config = JSON.parse(readFileSync(process.env.WAYSTATION_HOSTED_CONFIG, 'utf8'));
assert(config.organizations.length >= 2, 'Two test organizations are required');
const [a, b] = config.organizations; const subject = Object.keys(a.members).find(key => a.members[key] === 'admin');
assert(subject, 'The first test organization needs an administrator membership');
const secret = name => readFileSync(process.env[name], 'utf8').trim();
const identity = { host: new URL(config.publicOrigin).host, origin: config.publicOrigin, 'x-waystation-subject': subject, 'x-waystation-proxy-secret': secret('WAYSTATION_PROXY_SECRET_FILE'), 'content-type': 'application/json' };
let healthy = false;
for (let i = 0; i < 100; i++) { try { healthy = (await fetch('http://127.0.0.1:8080/healthz')).ok; } catch {} if (healthy) break; await new Promise(r => setTimeout(r, 200)); }
assert(healthy, 'Gateway did not become ready');
const httpJson = (url, method, headers, body) => new Promise((resolve, reject) => { const req = httpRequest(url, { method, headers }, res => { let value = ''; res.on('data', bytes => { value += bytes; }); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(value) }); } catch (error) { reject(error); } }); }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body)); });
const call = (method, path, body, headers = identity) => httpJson(`http://127.0.0.1:8080${path}`, method, headers, body);
const choice = await call('POST', '/api/hosted/organization', { organizationId: a.id }); assert.equal(choice.status, 200, choice.data.error);
// With the example's one membership, the gateway selects alpha automatically; choose was still authorization checked.
const session = await call('GET', '/api/hosted/session'); assert.equal(session.data.organization.id, a.id);
const draft = await call('POST', '/api/architectures', { project: a.project, graph: { title: 'Container smoke test', description: 'Generated only to verify the private hosted worker.', nodes: [], edges: [] } }); assert.equal(draft.status, 200);
const beta = await httpJson(`${b.upstream}/api/architectures`, 'GET', { host: '127.0.0.1:4317', 'x-tower-token': secret(b.tokenFileEnv) }); assert.equal(beta.status, 200);
assert(!beta.data.documents.some(doc => doc.id === draft.data.document.id), 'An organization must not see another worker’s workflow');
const credential = await call('POST', `/api/architectures/${draft.data.document.id}/connections`, { label: 'Container smoke test credential', provider: 'openai', model: 'test-only-no-request', apiKey: 'fixture-container-secret-never-used-for-provider-requests' }); assert.equal(credential.status, 200);
assert(!JSON.stringify(credential.data).includes('fixture-container-secret'));
assert.equal((await call('GET', '/api/consoles')).status, 403);
assert.equal((await call('GET', '/api/architectures', undefined, { ...identity, 'x-waystation-proxy-secret': 'invalid' })).status, 401);
assert.equal((await call('POST', '/api/architectures', { project: '/etc', graph: 'starter' })).status, 400);
console.log(JSON.stringify({ checks: ['Gateway and worker HTTP paths work in Linux containers', 'Organization state is isolated across separate workers', 'Credential values are excluded from API responses', 'Desktop escape routes and forged proxy authorization are denied', 'Hosted project paths stay inside the organization workspace'], workflowId: draft.data.document.id }));
