import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';
import { TOAST_BODY_ENV, TOAST_TITLE_ENV, encodedToastScript } from './channels/desktop.ts';
import type { DeliveryIo, MailMessage, SmtpOptions } from './channels/types.ts';

async function sendMail(options: SmtpOptions, mail: MailMessage): Promise<void> {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    // Never send a password over an unencrypted connection: STARTTLS is mandatory once there is one.
    requireTLS: !options.secure && Boolean(options.user),
    auth: options.user ? { user: options.user, pass: options.pass ?? '' } : undefined,
    connectionTimeout: options.timeoutMs,
    greetingTimeout: options.timeoutMs,
    socketTimeout: options.timeoutMs,
  });
  try {
    await transport.sendMail({ from: mail.from, to: [...mail.to], subject: mail.subject, text: mail.text });
  } finally {
    transport.close();
  }
}

function showToast(title: string, body: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedToastScript()], {
      env: { ...process.env, [TOAST_TITLE_ENV]: title, [TOAST_BODY_ENV]: body },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      signal,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-400); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell toast failed (exit ${code})${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}`));
    });
  });
}

/** Real side effects. `fetch` is looked up per call so tests can stub the global. */
export const defaultIo: DeliveryIo = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sendMail,
  showToast,
};
