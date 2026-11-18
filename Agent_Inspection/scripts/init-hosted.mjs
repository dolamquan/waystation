import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve('deploy/hosted'); const secrets = join(dir, 'secrets'); mkdirSync(secrets, { recursive: true, mode: 0o700 });
for (const name of ['proxy-secret', 'selection-secret', 'alpha-token', 'beta-token', 'alpha-key', 'beta-key']) {
  const path = join(secrets, name); if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString(name.endsWith('-key') ? 'base64' : 'hex'), { flag: 'wx', mode: 0o444 });
}
if (!existsSync(join(dir, 'organizations.json'))) copyFileSync(join(dir, 'organizations.example.json'), join(dir, 'organizations.json'));
if (!existsSync(join(dir, '.env'))) writeFileSync(join(dir, '.env'), `PUBLIC_HOST=agents.example.com\nOIDC_ISSUER=https://YOUR_IDENTITY_PROVIDER\nOIDC_CLIENT_ID=YOUR_CLIENT_ID\nOIDC_COOKIE_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
console.log('Created missing hosted configuration and secret files without replacing existing values. Set the host, OIDC settings and organization memberships, and write your client secret to deploy/hosted/secrets/oidc-client-secret. Secret values were not printed.');
