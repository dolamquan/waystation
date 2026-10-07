/**
 * Shared contract for the Library features: skills, context docs, MCP servers, Claude Code plugins
 * and notification channels, plus the "loadout" an agent is launched with.
 *
 * The web client imports these types directly, so they are the single source of truth for the API.
 */
import type { ManagedLaunch, RemoteMcpServer, StdioMcpServer } from '../managed/types.ts';

/** Bad input from the operator: the API answers 400 with the message. */
export class LibraryInputError extends Error {}

// ---- loadout ------------------------------------------------------------------------------------

/** What an agent carries beyond its prompt. Every field lists library ids. */
export interface LaunchLoadout {
  readonly skillIds?: readonly string[];
  /** Context docs the agent must read before starting its task. */
  readonly docIds?: readonly string[];
  readonly mcpIds?: readonly string[];
  /** Installed Claude Code plugins, by "name@marketplace". */
  readonly pluginIds?: readonly string[];
  /** Notification channels the agent may post updates to (gives it the `notify` tool). */
  readonly notifyChannelIds?: readonly string[];
}

/** One library module's share of a launch. `applyLoadout` merges them into the ManagedLaunch. */
export interface LoadoutContribution {
  /** Appended to the system prompt (Codex: ahead of the first turn). Joined with blank lines. */
  readonly appendSystemPrompt?: string;
  /** Local Claude Code plugin directories (SDK `plugins`). Claude only. */
  readonly plugins?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, StdioMcpServer>>;
  readonly remoteMcpServers?: Readonly<Record<string, RemoteMcpServer>>;
  /** Extra process environment (secrets go here, never on argv). */
  readonly env?: Readonly<Record<string, string>>;
  /** Operator-facing warnings, e.g. "plugins are ignored for Codex agents". */
  readonly notes?: readonly string[];
}

export interface LoadoutProvider {
  /**
   * `launch.agentId` is always set by the time providers run. Throw LibraryInputError for an unknown id.
   * Providers must ignore loadout fields that are not theirs.
   */
  contribute(loadout: LaunchLoadout, launch: ManagedLaunch): LoadoutContribution;
}

// ---- skills (agent A) ---------------------------------------------------------------------------

export interface LibrarySkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** "waystation" (created here, editable), "user" (~/.claude/skills) or "plugin:<name>". */
  readonly source: string;
  readonly editable: boolean;
}

export interface LibrarySkillDetail extends LibrarySkill {
  /** SKILL.md body without the frontmatter. */
  readonly body: string;
}

export interface SkillInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

// ---- context docs (agent B) ---------------------------------------------------------------------

export interface ContextDoc {
  readonly id: string;
  readonly title: string;
  /** Original file name when uploaded, e.g. "CONVENTIONS.md". */
  readonly filename?: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContextDocDetail extends ContextDoc {
  readonly content: string;
}

export interface ContextDocInput {
  readonly title: string;
  readonly filename?: string;
  readonly content: string;
}

// ---- MCP servers & plugins (agent C) ------------------------------------------------------------

export type McpTransport = 'stdio' | 'http' | 'sse';

/** As the API shows it: secret values are never returned, only their names. */
export interface McpServerView {
  readonly id: string;
  /** Server name the agent sees (tool prefix), e.g. "playwright". */
  readonly name: string;
  readonly label: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  /** Names of stored secrets (stdio: env vars; http/sse: headers). */
  readonly secretNames: readonly string[];
  /** Pre-selected in New agent. */
  readonly defaultOn: boolean;
  readonly presetId?: string;
  readonly createdAt: number;
}

export interface McpServerInput {
  readonly name: string;
  readonly label?: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  /** Write-only. A value of "" deletes that secret; an omitted name keeps it. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly defaultOn?: boolean;
  readonly presetId?: string;
}

/** A one-click starting point, e.g. Playwright, GitHub, Fetch. */
export interface McpPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly input: McpServerInput;
  /** Secrets the operator has to fill in, e.g. GITHUB_PERSONAL_ACCESS_TOKEN. */
  readonly requiredSecrets: readonly string[];
}

export interface McpTestResult {
  readonly ok: boolean;
  readonly tools?: readonly string[];
  readonly error?: string;
}

export interface PluginView {
  /** "name@marketplace". */
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly version?: string;
  readonly description?: string;
  readonly installPath: string;
  readonly skills: number;
  readonly mcpServers: number;
  /** Enabled in ~/.claude/settings.json (so every Claude agent already loads it). */
  readonly enabledGlobally: boolean;
  /** Pre-selected in New agent. */
  readonly defaultOn: boolean;
}

export interface AvailablePlugin {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly description?: string;
  readonly installed: boolean;
}

// ---- notifications (agent D) --------------------------------------------------------------------

export type NotifyKind = 'inbox' | 'slack' | 'discord' | 'email' | 'webhook' | 'ntfy' | 'desktop';

/** The in-app Updates inbox: always present, cannot be deleted. */
export const INBOX_CHANNEL_ID = 'inbox';

export interface NotifyChannelView {
  readonly id: string;
  readonly kind: NotifyKind;
  readonly label: string;
  /** Non-secret settings, e.g. { to: "me@gmail.com", smtpHost: "smtp.gmail.com" } or { topic: "..." }. */
  readonly config: Readonly<Record<string, string>>;
  /** Names of stored secrets (webhook URL, SMTP password, …). Values are never returned. */
  readonly secretNames: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly lastSentAt?: number;
  readonly lastError?: string;
}

export interface NotifyChannelInput {
  readonly kind: Exclude<NotifyKind, 'inbox'>;
  readonly label: string;
  readonly config?: Readonly<Record<string, string>>;
  /** Write-only. A value of "" deletes that secret; an omitted name keeps it. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
}

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotifyMessage {
  readonly title: string;
  readonly body: string;
  readonly level?: NotifyLevel;
  /** Who sent it, e.g. "schedule:Nightly GitHub sync" or "agent:<name>". */
  readonly source?: string;
  readonly agentId?: string;
}

export interface NotifyResult {
  readonly channelId: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** One entry in the in-app Updates inbox. */
export interface NotificationEntry extends NotifyMessage {
  readonly id: string;
  readonly ts: number;
  readonly read: boolean;
  /** Where else it was delivered. */
  readonly deliveries: readonly NotifyResult[];
}

/** What scheduling (and anything else) needs from notifications. */
export interface NotifySender {
  /** Always records to the inbox, then delivers to each listed channel. Never throws. */
  send(channelIds: readonly string[], message: NotifyMessage): Promise<NotifyResult[]>;
}

// ---- schedule resources (agent E) ---------------------------------------------------------------

export type ResourceKind = 'url' | 'github' | 'file' | 'folder' | 'note';

export interface ScheduleResource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly label?: string;
  /** URL, "owner/repo" (optionally "@branch"), absolute path, or note text. */
  readonly value: string;
}

export type ScheduleNotifyWhen = 'always' | 'failure' | 'never';

export interface ScheduleNotify {
  readonly channelIds: readonly string[];
  readonly when: ScheduleNotifyWhen;
}
