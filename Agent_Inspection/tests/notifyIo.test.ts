import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})), close: vi.fn(), createTransport: vi.fn() }));
const proc = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport } }));
vi.mock('node:child_process', () => ({ spawn: proc.spawn }));

const { defaultIo } = await import('../daemon/notify/io.ts');
const { TOAST_BODY_ENV, TOAST_TITLE_ENV } = await import('../daemon/notify/channels/desktop.ts');

function fakeChild(code: number, stderr = '') {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  setTimeout(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  }, 0);
  return child;
}

afterEach(() => vi.clearAllMocks());

describe('defaultIo.sendMail', () => {
  it('sends over an authenticated transport and always closes it', async () => {
    mail.createTransport.mockReturnValue({ sendMail: mail.sendMail, close: mail.close });
    await defaultIo.sendMail(
      { host: 'smtp.example.test', port: 587, secure: false, user: 'me', pass: 'pw', timeoutMs: 1000 },
      { from: 'me@x.test', to: ['a@x.test'], subject: 'S', text: 'T' },
    );
    expect(mail.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', requireTLS: true, auth: { user: 'me', pass: 'pw' }, socketTimeout: 1000 }));
    expect(mail.sendMail).toHaveBeenCalledWith({ from: 'me@x.test', to: ['a@x.test'], subject: 'S', text: 'T' });
    expect(mail.close).toHaveBeenCalled();
  });

  it('closes the transport when sending fails', async () => {
    mail.createTransport.mockReturnValue({ sendMail: vi.fn(async () => { throw new Error('auth failed'); }), close: mail.close });
    await expect(defaultIo.sendMail({ host: 'h', port: 465, secure: true, timeoutMs: 1 }, { from: 'a@b.c', to: ['a@b.c'], subject: '', text: '' })).rejects.toThrow('auth failed');
    expect(mail.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined, requireTLS: false }));
    expect(mail.close).toHaveBeenCalled();
  });
});

describe('defaultIo.showToast', () => {
  it('passes the text through the environment, not the command line', async () => {
    proc.spawn.mockReturnValue(fakeChild(0));
    await defaultIo.showToast('Title $(x)', 'Body', new AbortController().signal);
    const [command, args, options] = proc.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-EncodedCommand');
    expect(args.join(' ')).not.toContain('Title');
    expect(options.env[TOAST_TITLE_ENV]).toBe('Title $(x)');
    expect(options.env[TOAST_BODY_ENV]).toBe('Body');
  });

  it('reports a failing PowerShell', async () => {
    proc.spawn.mockReturnValue(fakeChild(1, 'boom\nmore'));
    await expect(defaultIo.showToast('t', 'b', new AbortController().signal)).rejects.toThrow('PowerShell toast failed (exit 1): boom');
  });
});

describe('defaultIo.fetch', () => {
  it('uses the global fetch at call time', async () => {
    const stub = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', stub);
    await defaultIo.fetch('https://x.test');
    expect(stub).toHaveBeenCalledWith('https://x.test', undefined);
    vi.unstubAllGlobals();
  });
});
