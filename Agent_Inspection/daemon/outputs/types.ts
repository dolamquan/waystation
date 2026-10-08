/** What an agent produced: shared by the daemon's outputs endpoints and the Outputs tab. */

export interface OutputTurn {
  /** Stable within one response: the turn's start time plus its position. */
  readonly id: string;
  /** The request that started the turn (clipped like every recorded event). Absent when the session was picked up mid-turn. */
  readonly prompt?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** A completion marker was seen, or a later request superseded the turn. */
  readonly complete: boolean;
  /** The agent's last message in the turn. */
  readonly result?: string;
  readonly resultAt?: number;
  readonly toolCalls: number;
  /** Files written or edited during the turn (display paths). */
  readonly files: readonly string[];
  readonly errors: readonly string[];
}

export interface ChangedFile {
  /** Relative to the agent's folder (forward slashes) when inside it; otherwise the path as recorded. */
  readonly path: string;
  readonly insideCwd: boolean;
  readonly touches: number;
  readonly firstTouchedAt: number;
  readonly lastTouchedAt: number;
  /** Tool names that touched it, e.g. ["Edit", "Write"]. */
  readonly tools: readonly string[];
  /** Porcelain status code ("M ", "??", …) when git currently reports the file as changed. */
  readonly gitStatus?: string;
}

export interface StatusEntry {
  /** Two-letter porcelain code, e.g. " M", "A ", "??", "R ". */
  readonly code: string;
  /** Relative to the agent's folder, forward slashes. */
  readonly path: string;
  /** Previous path for renames and copies. */
  readonly from?: string;
}

export interface CommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly ts: number;
  readonly subject: string;
}

export type GitOverview =
  | { readonly available: false; readonly reason: string }
  | {
    readonly available: true;
    readonly branch?: string;
    /** Uncommitted changes anywhere in the agent's folder, by anyone. */
    readonly status: readonly StatusEntry[];
    readonly statusTruncated: boolean;
    readonly diffStat: string;
    /** Commits in the repository since the agent started, by anyone. */
    readonly commits: readonly CommitInfo[];
    readonly commitsSince?: number;
  };

export interface AgentOutputs {
  readonly agentId: string;
  readonly cwd?: string;
  readonly generatedAt: number;
  /** Newest first. */
  readonly turns: readonly OutputTurn[];
  /** Most recently touched first. */
  readonly files: readonly ChangedFile[];
  readonly eventsScanned: number;
  /** True when older history was cut off by the scan limit. */
  readonly eventsCapped: boolean;
  readonly git: GitOverview;
}

export type FileDiffKind = 'diff' | 'untracked' | 'clean' | 'ignored' | 'binary' | 'missing' | 'preview';

export interface FileDiff {
  readonly path: string;
  readonly kind: FileDiffKind;
  /** Patch (kind "diff") or file content (kinds "untracked" and "preview"), redacted and capped. */
  readonly text: string;
  readonly truncated: boolean;
  /** Plain-language explanation for the UI. */
  readonly note?: string;
}
