import type { TokenCounts } from '../domain/types.ts';

/** Where a real plan-limit reading came from. */
export type LimitSource = 'codex' | 'claude-sdk' | 'claude-transcript';

/** A plan-limit window as reported by the vendor (not computed by Waystation). */
export interface PlanLimit {
  /** 'five_hour', 'weekly' (Codex), 'seven_day', 'seven_day_opus', … */
  readonly window: string;
  readonly label: string;
  /** 0-100 when the vendor reported it. */
  readonly usedPercent?: number;
  /** Claude only: whether requests are still allowed. */
  readonly status?: 'allowed' | 'allowed_warning' | 'rejected';
  /** Epoch ms. */
  readonly resetsAt?: number;
  readonly windowMinutes?: number;
  /** When this reading was written (epoch ms). */
  readonly observedAt: number;
  readonly source: LimitSource;
}

/** Usage estimated from local transcripts over [start, end). */
export interface ComputedWindow {
  readonly start: number;
  readonly end: number;
  readonly tokens: TokenCounts;
  readonly totalTokens: number;
  /** List-price estimate of the priced part; absent when nothing in the window had a known price. */
  readonly costUsd?: number;
  /** Tokens from models without a known price (Codex/OpenAI). */
  readonly unpricedTokens: number;
  readonly requests: number;
  readonly lastActivityAt?: number;
}

export interface VendorWindows {
  readonly vendor: 'claude' | 'codex';
  /** Real readings, newest per window. Empty when the vendor reported none locally. */
  readonly limits: readonly PlanLimit[];
  readonly planType?: string;
  /** The current ccusage-style 5-hour block, absent when no block is active. */
  readonly block?: ComputedWindow;
  /** Rolling last 7 days. */
  readonly week: ComputedWindow;
}

export interface UsageWindowsReport {
  readonly generatedAt: number;
  readonly vendors: readonly VendorWindows[];
  /** Transcript files modified within the last 7 days. */
  readonly files: number;
  /** Files (re)read on this refresh; unchanged files come from the cache. */
  readonly filesRead: number;
  readonly scanMs: number;
}
