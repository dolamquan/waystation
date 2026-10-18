import { describe, expect, it } from 'vitest';
import { redact } from '../daemon/domain/text.ts';
import { cleanMessage } from '../daemon/notify/validate.ts';

// Synthetic values only: shaped like real secrets, none of them valid anywhere.
const LEAKY_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['Stripe live key', `${'sk'}${'_live_'}4eC39HqLyjWDarjtT1zdp7dcFAKE`],
  ['Slack webhook', `https://hooks.${'slack'}.com/services/T0FAKE000/B0FAKE000/abcdEFGHijklMNOPqrstUVWX`],
  ['Discord webhook', 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghiJKL-mnoPQRstuVWXyz0123456789abcdefghij'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXVzZXIifQ.c2lnbmF0dXJlLWZha2UtdmFsdWU'],
  ['DB URL credentials', 'postgres://appuser:hunter2hunter2@db.internal:5432/app'],
  ['AWS secret key', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY00'],
  ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['SendGrid key', 'SG.abcdefghijklmnopqrstuv.wxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0'],
  ['Google API key', `${'AI'}${'zaSyA-abcdefghijklmnopqrstuvwxyz01234'}`],
  ['Basic auth header', 'Authorization: Basic dXNlcjpwYXNzd29yZC1mYWtl'],
  ['fine-grained GitHub PAT', `${'github_'}${'pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'}`],
  ['--password flag', '--password hunter2hunter2'],
  ['--token flag', '--token abcd1234efgh5678'],
  ['JSON passwd', '{"passwd":"hunter2hunter2"}'],
];

const SECRET_CORE = /FAKE|hunter2|abcdefghijklmnopqrstuv|dXNlcjpw|eyJhbGci|wJalrXU|11ABCDEFG|abcd1234efgh/;

describe('redact', () => {
  it.each(LEAKY_SAMPLES)('removes a %s', (_name, sample) => {
    // Act
    const out = redact(`before ${sample} after`);

    // Assert
    expect(out).not.toMatch(SECRET_CORE);
    expect(out).toContain('[REDACTED]');
  });

  it('removes a PEM private key block', () => {
    const dashes = '-----';
    const pem = `${dashes}BEGIN RSA PRIVATE ${'KEY'}${dashes}\nMIIBOgIBAAJBAKFAKEFAKEFAKE\n${dashes}END RSA PRIVATE ${'KEY'}${dashes}`;
    expect(redact(`key:\n${pem}\n`)).not.toContain('MIIBOgIBAAJB');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Refactored the token counter and ran 12 tests at https://example.com/docs';
    expect(redact(text)).toBe(text);
  });
});

describe('cleanMessage', () => {
  it('redacts secrets an agent puts in a notification title or body', () => {
    const out = cleanMessage({ title: 'key sk-abcdefghijklmnopqrstuvwx', body: 'see postgres://u:hunter2hunter2@h/db' }, 1);
    expect(`${out.title} ${out.body}`).not.toMatch(/abcdefghijklmnopqrstuv|hunter2/);
  });
});
