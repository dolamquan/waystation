import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function secretEncryptionKey(): Buffer | undefined {
  const file = process.env.WAYSTATION_SECRETS_KEY_FILE;
  if (!file) { if (process.env.WAYSTATION_HOSTED === '1') throw new Error('Hosted workers require WAYSTATION_SECRETS_KEY_FILE.'); return; }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('The secret encryption key file must contain a base64-encoded 32-byte key.');
  return key;
}
export function encodeSecrets(values: Readonly<Record<string, string>>, key?: Buffer): string {
  if (!key) return JSON.stringify(values, null, 2);
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('waystation-secrets:v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, encryption: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function decodeSecrets(raw: string, key?: Buffer): string {
  let envelope: any; try { envelope = JSON.parse(raw); } catch { return raw; }
  if (envelope?.encryption === undefined) return raw;
  if (envelope.version !== 1 || envelope.encryption !== 'aes-256-gcm' || !key) throw new Error('Encrypted secrets cannot be opened with the configured key.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from('waystation-secrets:v1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new Error('Encrypted secrets failed authentication. Check the key and restore a valid backup.'); }
}
