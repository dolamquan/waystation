import { vi, type Mock } from 'vitest';
import type { LibraryDeps } from '../daemon/library/deps.ts';
import { SecretStore } from '../daemon/library/secretStore.ts';
import type { DeliveryIo } from '../daemon/notify/channels/types.ts';
import { Notifier, type NotifierOptions } from '../daemon/notify/notifier.ts';
import { TowerStore } from '../daemon/store/db.ts';

export const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/SuperSecretSlackPath';
export const DISCORD_URL = 'https://discord.com/api/webhooks/123/SuperSecretDiscordToken';

type AuditFn = (action: string, target: string, detail: unknown) => void;

export function makeDeps(): LibraryDeps & { readonly audit: Mock<AuditFn> } {
  return {
    store: new TowerStore(':memory:'),
    secrets: new SecretStore(':memory:'),
    paths: { skillsLibraryDir: '', docsDir: '', loadoutsDir: '', claudeHome: '' },
    audit: vi.fn<AuditFn>(),
  };
}

export interface Harness {
  readonly notifier: Notifier;
  readonly deps: ReturnType<typeof makeDeps>;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly sendMail: ReturnType<typeof vi.fn>;
  readonly showToast: ReturnType<typeof vi.fn>;
  readonly clock: { now: number };
}

export function makeNotifier(options: NotifierOptions = {}): Harness {
  const deps = makeDeps();
  const clock = { now: 1_700_000_000_000 };
  const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
  const sendMail = vi.fn(async () => undefined);
  const showToast = vi.fn(async () => undefined);
  const io: DeliveryIo = { fetch: fetch as unknown as typeof globalThis.fetch, sendMail, showToast };
  const notifier = new Notifier(deps, { io, now: () => clock.now, ...options });
  return { notifier, deps, fetch, sendMail, showToast, clock };
}

/** The JSON body of the n-th fetch call. */
export const fetchBody = (fetch: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
  JSON.parse(String((fetch.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;
