import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TokenCounts } from '../domain/types.ts';
import {
  ZERO_TOKENS, claudeUsageSample, codexRolloutModel, codexRolloutUsage, scanJsonl, subtractTokens, totalTokens,
} from './usageMeter.ts';
import { claudeQuotaLimit, codexRateLimits, latestPerWindow, type ClaudePlanReading } from './planLimits.ts';
import { activeBlock, sumWindow, type UsageEntry } from './usageBlocks.ts';
import type { ComputedWindow, PlanLimit, UsageWindowsReport, VendorWindows } from './windowTypes.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The page polls about once a minute; a report younger than this is served from memory. */
const DEFAULT_REFRESH_MS = 60_000;

type Vendor = VendorWindows['vendor'];

interface ClaudeEntry extends UsageEntry {
  readonly messageId: string;
}

/** What one transcript contributed, kept until its size or mtime changes. */
interface FileScan {
  readonly mtimeMs: number;
  readonly size: number;
  readonly claude: readonly ClaudeEntry[];
  readonly codex: readonly UsageEntry[];
  readonly limits: readonly PlanLimit[];
  readonly planType?: string;
}

export interface UsageWindowsOptions {
  readonly claudeProjectsDir: string;
  readonly codexSessionsDir: string;
  /** Latest Claude limits reported live by managed agents (Agent SDK rate_limit_event). */
  readonly liveClaudeLimits: () => readonly PlanLimit[];
  /** Read Claude's structured /usage data without running a model turn. */
  readonly readClaudePlanUsage?: () => Promise<ClaudePlanReading | undefined>;
  readonly refreshMs?: number;
}

const timestampOf = (line: unknown): number | undefined => {
  const raw = (line as { timestamp?: unknown } | null)?.timestamp;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function listJsonl(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { recursive: true });
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name));
  } catch (error) {
    if (!isMissing(error)) console.error(`[usage windows] cannot list ${dir}:`, error);
    return [];
  }
}

async function scanClaudeFile(file: string): Promise<Pick<FileScan, 'claude' | 'codex' | 'limits'>> {
  const claude: ClaudeEntry[] = [];
  const limits: PlanLimit[] = [];
  await scanJsonl(file, (line) => {
    const ts = timestampOf(line);
    if (ts === undefined) return;
    const sample = claudeUsageSample(line);
    if (sample) claude.push({ ts, messageId: sample.messageId, model: sample.model, tokens: sample.tokens });
    const limit = claudeQuotaLimit(line, ts);
    if (limit) limits.push(limit);
  });
  return { claude, codex: [], limits: latestPerWindow(limits) };
}

/** Codex totals are cumulative per thread: each token_count contributes its delta. */
async function scanCodexFile(file: string): Promise<Pick<FileScan, 'claude' | 'codex' | 'limits' | 'planType'>> {
  const codex: UsageEntry[] = [];
  let previous: TokenCounts = ZERO_TOKENS;
  let model: string | undefined;
  let latest: ReturnType<typeof codexRateLimits>;
  await scanJsonl(file, (line) => {
    model = codexRolloutModel(line) ?? model;
    const ts = timestampOf(line);
    const usage = codexRolloutUsage(line);
    if (usage) {
      const delta = subtractTokens(usage.total, previous);
      previous = usage.total;
      if (ts !== undefined && totalTokens(delta) > 0) codex.push({ ts, tokens: delta, model });
    }
    const reading = ts !== undefined ? codexRateLimits(line, ts) : undefined;
    if (reading && (!latest || reading.observedAt >= latest.observedAt)) latest = reading;
  });
  return { claude: [], codex, limits: latest?.limits ?? [], ...(latest?.planType ? { planType: latest.planType } : {}) };
}

/** Streaming rewrites a Claude message under the same id: keep its fullest reading once, across all files. */
function dedupeClaude(entries: Iterable<ClaudeEntry>): ClaudeEntry[] {
  const byId = new Map<string, ClaudeEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.messageId);
    if (!current || totalTokens(entry.tokens) >= totalTokens(current.tokens)) byId.set(entry.messageId, entry);
  }
  return [...byId.values()];
}

function vendorWindows(vendor: Vendor, entries: readonly UsageEntry[], limits: readonly PlanLimit[], now: number, planType?: string): VendorWindows {
  const weekStart = now - WEEK_MS;
  const recent = entries.filter((entry) => entry.ts >= weekStart && entry.ts <= now);
  const block = activeBlock(recent, now);
  const blockWindow: ComputedWindow | undefined = block ? sumWindow(block.entries, block.start, block.end) : undefined;
  return {
    vendor,
    limits,
    ...(planType ? { planType } : {}),
    ...(blockWindow ? { block: blockWindow } : {}),
    week: sumWindow(recent, weekStart, now),
  };
}

/**
 * Plan-limit windows per vendor: real readings where the vendor writes them locally, plus 5-hour block and
 * 7-day estimates from local transcripts. Only files modified in the last 7 days are read, and each is
 * re-read only when its size or mtime changes.
 */
export class UsageWindows {
  private readonly files = new Map<string, FileScan>();
  private cached: UsageWindowsReport | undefined;
  private inflight: Promise<UsageWindowsReport> | undefined;
  private readonly refreshMs: number;

  constructor(private readonly options: UsageWindowsOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  }

  async report(now = Date.now()): Promise<UsageWindowsReport> {
    if (this.cached && now - this.cached.generatedAt < this.refreshMs) return this.cached;
    this.inflight ??= this.build(now).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async build(now: number): Promise<UsageWindowsReport> {
    const started = Date.now();
    const [claudeFiles, codexFiles, claudePlan] = await Promise.all([
      listJsonl(this.options.claudeProjectsDir), listJsonl(this.options.codexSessionsDir),
      this.options.readClaudePlanUsage?.().catch(() => undefined),
    ]);
    const seen = new Set<string>();
    let filesRead = 0;
    const load = async (file: string, vendor: Vendor): Promise<FileScan | undefined> => {
      const info = await stat(file).catch(() => undefined);
      if (!info || info.mtimeMs < now - WEEK_MS) return undefined;
      seen.add(file);
      const cached = this.files.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
      try {
        const parsed = vendor === 'claude' ? await scanClaudeFile(file) : await scanCodexFile(file);
        const scan: FileScan = { mtimeMs: info.mtimeMs, size: info.size, ...parsed };
        this.files.set(file, scan);
        filesRead += 1;
        return scan;
      } catch (error) {
        if (!isMissing(error)) console.error(`[usage windows] cannot read ${file}:`, error);
        return undefined;
      }
    };
    // Sequential on purpose: a cold start reads every recent transcript, and this keeps disk pressure low.
    const claudeScans: FileScan[] = [];
    for (const file of claudeFiles) {
      const scan = await load(file, 'claude');
      if (scan) claudeScans.push(scan);
    }
    const codexScans: FileScan[] = [];
    for (const file of codexFiles) {
      const scan = await load(file, 'codex');
      if (scan) codexScans.push(scan);
    }
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file);

    const claudeLimits = latestPerWindow([
      // A transcript records only "limit hit, resets at X": once X has passed it says nothing about now.
      ...claudeScans.flatMap((scan) => scan.limits).filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now),
      ...this.options.liveClaudeLimits(),
      ...(claudePlan?.limits ?? []),
    ]);
    const latestCodex = codexScans
      .filter((scan) => scan.limits.length > 0)
      .reduce<FileScan | undefined>((best, scan) => (!best || scan.limits[0].observedAt > best.limits[0].observedAt ? scan : best), undefined);

    const report: UsageWindowsReport = {
      generatedAt: now,
      vendors: [
        vendorWindows('claude', dedupeClaude(claudeScans.flatMap((scan) => scan.claude)), claudeLimits, now, claudePlan?.planType),
        vendorWindows('codex', codexScans.flatMap((scan) => scan.codex), latestCodex?.limits ?? [], now, latestCodex?.planType),
      ],
      files: seen.size,
      filesRead,
      scanMs: Date.now() - started,
    };
    this.cached = report;
    return report;
  }
}
