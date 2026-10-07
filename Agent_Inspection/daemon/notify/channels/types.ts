import type { NotifyKind, NotifyLevel } from '../../library/types.ts';

/** A message after validation: every field present and clipped. */
export interface CleanMessage {
  readonly title: string;
  readonly body: string;
  readonly level: NotifyLevel;
  readonly source: string;
  readonly agentId?: string;
  readonly ts: number;
}

/** Side effects a channel may use. Tests replace them. */
export interface DeliveryIo {
  readonly fetch: typeof fetch;
  readonly sendMail: (options: SmtpOptions, mail: MailMessage) => Promise<void>;
  readonly showToast: (title: string, body: string, signal: AbortSignal) => Promise<void>;
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly pass?: string;
  readonly timeoutMs: number;
}

export interface MailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

export interface DeliveryContext {
  readonly config: Readonly<Record<string, string>>;
  readonly secret: (name: string) => string | undefined;
  readonly message: CleanMessage;
  readonly signal: AbortSignal;
  readonly io: DeliveryIo;
}

export type ExternalKind = Exclude<NotifyKind, 'inbox'>;

/** What a channel kind accepts and how it delivers. */
export interface ChannelSpec {
  readonly kind: ExternalKind;
  readonly configKeys: readonly string[];
  readonly requiredConfig: readonly string[];
  readonly secretNames: readonly string[];
  readonly requiredSecrets: readonly string[];
  /** Throws LibraryInputError when the combined settings are unusable. */
  readonly validate: (config: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string | undefined>>) => void;
  readonly deliver: (ctx: DeliveryContext) => Promise<void>;
}
