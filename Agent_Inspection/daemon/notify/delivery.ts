import { redact } from '../domain/text.ts';
import { clip } from './channels/http.ts';
import type { ChannelSpec, CleanMessage, DeliveryIo } from './channels/types.ts';

export const DELIVERY_TIMEOUT_MS = 15_000;
const ERROR_MAX = 300;
const MIN_SECRET_LENGTH = 4;

export type DeliveryOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface DeliveryJob {
  readonly spec: ChannelSpec;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly message: CleanMessage;
  readonly io: DeliveryIo;
  readonly timeoutMs: number;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message;
}

/** Errors leave the daemon (API, UI, audit): strip every secret of the channel and any URL path. */
export function scrubError(message: string, secrets: readonly string[]): string {
  const withoutSecrets = secrets
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .flatMap((value) => [value, encodeURIComponent(value)])
    .reduce((text, value) => text.split(value).join('[redacted]'), message);
  const withoutUrls = withoutSecrets.replace(/\bhttps?:\/\/[^\s/"']+[^\s"']*/gi, (url) => {
    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return '[url]';
    }
  });
  return clip(redact(withoutUrls), ERROR_MAX) || 'delivery failed';
}

/** One channel, one attempt, bounded by the timeout. Never throws. */
export async function deliverOnce(job: DeliveryJob): Promise<DeliveryOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${Math.round(job.timeoutMs / 1000)}s`));
    }, job.timeoutMs);
  });
  try {
    const attempt = job.spec.deliver({
      config: job.config,
      secret: (name) => job.secrets[name],
      message: job.message,
      signal: controller.signal,
      io: job.io,
    });
    await Promise.race([attempt, timeout]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: scrubError(describe(error), Object.values(job.secrets)) };
  } finally {
    clearTimeout(timer);
  }
}
