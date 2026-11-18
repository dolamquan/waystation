/** Exercises the pinned real OAuth2 Proxy against a private, simulated OIDC issuer.
 * No public ports, real identities, credentials or provider requests are used.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const delay = ms => new Promise(r => setTimeout(r, ms));
const issuer = 'http://oidc-fixture:8081';
const subject = 'immutable-fixture-subject';
const clientId = 'waystation-fixture';
const secret = 'fixture-proxy-secret-for-private-verification-only';

if (!process.env.WAYSTATION_OIDC_FIXTURE) {
  const suffix = randomUUID().slice(0, 8); const network = `waystation-oidc-check-${suffix}`;
  const fixture = `${network}-issuer`; const proxy = `${network}-proxy`;
  const dir = resolve('.impeccable/production-workflows/oidc'); mkdirSync(dir, { recursive: true });
  const yaml = readFileSync('deploy/hosted/oauth2-proxy.yaml', 'utf8')
    .replace('${OIDC_CLIENT_ID}', clientId).replace('${OIDC_ISSUER}', issuer)
    .replace('clientSecretFile: /run/secrets/oidc-client-secret', 'clientSecret: fixture-client-secret')
    .replace('http://gateway:8080', 'http://oidc-fixture:8082');
  writeFileSync(resolve(dir, 'alpha.yaml'), yaml); writeFileSync(resolve(dir, 'proxy-secret'), secret);
  const docker = (...args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
    return args[0] === 'logs' ? result.stdout + result.stderr : result.stdout;
  };
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  try {
    docker('network', 'create', network);
    docker('run', '-d', '--name', fixture, '--network', network, '--network-alias', 'oidc-fixture', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env', 'WAYSTATION_OIDC_FIXTURE=1', '--entrypoint', 'node', 'waystation-hosted:local', '--input-type=module', '-e', `await import('data:text/javascript;base64,${Buffer.from(source).toString('base64')}')`);
    docker('run', '-d', '--name', proxy, '--network', network, '--network-alias', 'identity', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=bind,src=${dir},dst=/run/secrets,readonly`, 'quay.io/oauth2-proxy/oauth2-proxy:v7.14.0', '--alpha-config=/run/secrets/alpha.yaml', '--reverse-proxy=true', '--cookie-secret=' + randomBytes(32).toString('base64url'), '--cookie-secure=true', '--cookie-httponly=true', '--cookie-samesite=lax', '--cookie-refresh=5m', '--cookie-expire=8h', '--email-domain=*', '--skip-provider-button=true', '--request-logging=false', '--redirect-url=https://agents.example.test/oauth2/callback');
    for (let i = 0; i < 60; i++) {
      const logs = docker('logs', fixture);
      if (logs.includes('OIDC verification passed')) { console.log(logs.trim()); writeFileSync(resolve(dir, 'result.json'), JSON.stringify({ passed: true, checks: ['Real proxy starts with the shipped alpha schema', 'Signed OIDC login validates nonce and PKCE S256', 'Immutable subject and proxy secret overwrite forged incoming headers', 'Unauthenticated access cannot reach the protected API'] }, null, 2)); break; }
      const state = docker('inspect', '--format', '{{.State.Running}}', fixture).trim();
      const proxyRunning = docker('inspect', '--format', '{{.State.Running}}', proxy).trim();
      if (state !== 'true' || proxyRunning !== 'true' || i === 59) throw new Error(`OIDC fixture failed. ${docker('logs', fixture)} ${docker('logs', '--tail', '20', proxy)}`);
      await delay(1000);
    }
  } finally {
    for (const name of [proxy, fixture]) try { docker('rm', '-f', name); } catch {}
    try { docker('network', 'rm', network); } catch {}
  }
} else {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const codes = new Map(); let redeemed = false;
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      if (url.pathname === '/.well-known/openid-configuration') return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
      if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert(url.searchParams.get('nonce'));
        const code = randomBytes(24).toString('hex'); codes.set(code, Object.fromEntries(url.searchParams));
        const target = new URL(url.searchParams.get('redirect_uri')); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state')); return redirect(res, target.href);
      }
      if (url.pathname === '/token') {
        let body = ''; for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body); const code = codes.get(params.get('code')); assert(code); codes.delete(params.get('code'));
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), code.code_challenge); redeemed = true;
        const now = Math.floor(Date.now() / 1000); const payload = { iss: issuer, aud: clientId, sub: subject, email: 'fixture@example.test', email_verified: true, nonce: code.nonce, iat: now, exp: now + 3600 };
        const token = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
        return json(res, 200, { access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600, id_token: `${token}.${sign('RSA-SHA256', Buffer.from(token), privateKey).toString('base64url')}` });
      }
      if (url.pathname === '/userinfo') return json(res, 200, { sub: subject, email: 'fixture@example.test', email_verified: true });
      json(res, 404, {});
    } catch (error) { console.error(error); json(res, 400, { error: 'fixture validation failed' }); }
  });
  const protectedApi = createServer((req, res) => {
    const valid = req.headers['x-waystation-subject'] === subject && req.headers['x-waystation-proxy-secret'] === secret;
    json(res, valid ? 200 : 403, { subject: req.headers['x-waystation-subject'], valid });
  });
  await new Promise(r => provider.listen(8081, '0.0.0.0', r)); await new Promise(r => protectedApi.listen(8082, '0.0.0.0', r));
  const cookies = new Map();
  const http = (host, path, withCookies = true) => new Promise((resolve, reject) => {
    const req = request(`http://${host}${path}`, { headers: { host: 'agents.example.test', 'x-forwarded-proto': 'https', 'x-waystation-subject': 'forged-subject', 'x-waystation-proxy-secret': 'forged-secret', ...(withCookies ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) } }, res => {
      if (withCookies) for (const value of res.headers['set-cookie'] ?? []) { const pair = value.split(';')[0]; const index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.setTimeout(1000, () => req.destroy(new Error('Fixture request timed out'))); req.end();
  });
  try {
    let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await http('identity:4180', '/ping')).status === 200; } catch {} if (ready) break; await delay(200); } assert(ready, 'Real proxy did not start');
    const anonymous = await http('identity:4180', '/api/protected', false); assert.notEqual(anonymous.status, 200);
    const start = await http('identity:4180', '/oauth2/start?rd=/api/protected'); assert.equal(start.status, 302);
    const authUrl = new URL(start.headers.location); const auth = await http('oidc-fixture:8081', `${authUrl.pathname}${authUrl.search}`); assert.equal(auth.status, 302);
    const callbackUrl = new URL(auth.headers.location); const callback = await http('identity:4180', `${callbackUrl.pathname}${callbackUrl.search}`); assert.equal(callback.status, 302, callback.body);
    const result = await http('identity:4180', '/api/protected'); assert.equal(result.status, 200, result.body); assert.deepEqual(JSON.parse(result.body), { subject, valid: true }); assert(redeemed);
    console.log('OIDC verification passed: real proxy, signed login, nonce, PKCE, immutable subject and forged-header replacement.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { provider.close(); protectedApi.close(); }
}
