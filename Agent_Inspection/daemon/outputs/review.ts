import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { AgentEvent } from '../domain/types.ts';
import type { TowerStore } from '../store/db.ts';
import { redact } from '../domain/text.ts';
import { resolveInsideCwd } from './pathSafety.ts';
import { agentOutputs, type OutputsDeps } from './service.ts';
import type { AgentOutputs } from './types.ts';

export interface RecordedCheck {
  readonly command: string;
  readonly ts: number;
  readonly outcome: 'passed' | 'failed' | 'unknown';
  readonly output?: string;
}
export interface ReviewDecision {
  readonly id: string;
  readonly fingerprint: string;
  readonly decision: 'reviewed' | 'verified';
  readonly acceptance: string;
  readonly unresolved: string;
  readonly checksReviewed: boolean;
  readonly reviewedAt: number;
}
export interface CompletionReview {
  readonly agentId: string;
  readonly originalRequest?: string;
  readonly result?: string;
  readonly agentFinished: boolean;
  readonly checks: readonly RecordedCheck[];
  readonly errors: readonly string[];
  readonly fingerprint: string;
  readonly limitations: readonly string[];
  readonly saved?: ReviewDecision;
  readonly stale: boolean;
  readonly status: 'needs-review' | 'reviewed' | 'verified';
}
export class ReviewError extends Error {}

const CHECK_COMMAND = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck|lint|check|build)\b|\b(?:pytest|vitest|jest|tsc|eslint|playwright)\b|\b(?:cargo|go|dotnet)\s+(?:test|check|build)\b|\bpython(?:3)?\s+-m\s+(?:pytest|unittest)\b)/i;

/** Results come from tool outcomes, never from an assistant's claim that tests passed. */
export function recordedChecks(events: readonly AgentEvent[]): RecordedCheck[] {
  const calls = new Map<string, string>();
  const checks: RecordedCheck[] = [];
  for (const event of events) {
    const tool = event.tool;
    if (event.kind === 'tool_call' && tool?.id && tool.command) calls.set(tool.id, tool.command);
    if (event.kind !== 'tool_result') continue;
    const command = tool?.command ?? (tool?.id ? calls.get(tool.id) : undefined);
    if (!command || !CHECK_COMMAND.test(command)) continue;
    checks.push({ command: redact(command), ts: event.ts, output: tool?.output ? redact(tool.output) : undefined,
      outcome: tool?.failed === true || typeof tool?.exitCode === 'number' && tool.exitCode !== 0 ? 'failed'
        : tool?.exitCode === 0 ? 'passed' : 'unknown' });
  }
  return checks;
}

async function fingerprint(outputs: AgentOutputs, events: readonly AgentEvent[]): Promise<{ value: string; limitations: string[] }> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ events, git: outputs.git, files: outputs.files }));
  const limitations: string[] = [];
  if (outputs.eventsCapped) limitations.push('Only the latest 3,000 events are available for this review.');
  if (outputs.git.available && outputs.git.statusTruncated) limitations.push('The folder has more changed files than this review can include.');
  const files = new Set([
    ...outputs.files.filter(file => file.insideCwd).map(file => file.path),
    ...(outputs.git.available ? outputs.git.status.map(file => file.path) : []),
  ]);
  for (const file of [...files].sort()) {
    try {
      if (!outputs.cwd) throw new Error('Project folder unknown');
      const safe = resolveInsideCwd(outputs.cwd, file);
      hash.update(file);
      if (safe.exists) for await (const chunk of createReadStream(safe.abs)) hash.update(chunk as Buffer);
      else hash.update('missing');
    } catch { limitations.push(`Could not include ${file} in the review snapshot.`); }
  }
  return { value: hash.digest('hex'), limitations };
}

export async function completionReview(deps: OutputsDeps, store: TowerStore, agentId: string, originalRequest?: string): Promise<CompletionReview> {
  const outputs = await agentOutputs(deps, agentId);
  const events = deps.events(agentId, 3000);
  const agent = deps.agent(agentId)!;
  const snapshot = await fingerprint(outputs, events.filter(event => !/^Message queue updated$/.test(event.summary) && event.kind !== 'system'));
  const latest = outputs.turns[0];
  const checks = recordedChecks(events.filter(event => !latest || event.ts >= latest.startedAt));
  const saved = store.loadRecords<ReviewDecision>('completion_reviews').find(review => review.id === agentId);
  const stale = !!saved && saved.fingerprint !== snapshot.value;
  return { agentId, originalRequest: originalRequest ?? [...outputs.turns].reverse().find(turn => turn.prompt)?.prompt,
    result: latest?.result, agentFinished: !!latest?.complete && agent.status !== 'busy' && agent.status !== 'waiting' && !agent.lastError,
    checks, errors: latest?.errors ?? [], fingerprint: snapshot.value, limitations: snapshot.limitations,
    saved, stale, status: saved && !stale ? saved.decision : 'needs-review' };
}

export async function saveCompletionReview(deps: OutputsDeps, store: TowerStore, agentId: string, raw: unknown, originalRequest?: string): Promise<CompletionReview> {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const review = await completionReview(deps, store, agentId, originalRequest);
  if (typeof body.fingerprint !== 'string' || body.fingerprint !== review.fingerprint) throw new ReviewError('The conversation or files changed. Refresh and review the latest work before saving.');
  if (body.decision !== 'reviewed' && body.decision !== 'verified') throw new ReviewError('Choose reviewed or verified.');
  const acceptance = typeof body.acceptance === 'string' ? body.acceptance.trim() : '';
  const unresolved = typeof body.unresolved === 'string' ? body.unresolved.trim() : '';
  if (acceptance.length > 8000 || unresolved.length > 8000) throw new ReviewError('Review notes must be under 8,000 characters.');
  if (body.decision === 'verified') {
    if (!review.agentFinished) throw new ReviewError('The latest turn has not finished successfully. Save your review notes instead.');
    if (!acceptance || body.checksReviewed !== true) throw new ReviewError('Describe how you checked the request and confirm you reviewed applicable tests.');
    if (unresolved) throw new ReviewError('Resolve the outstanding issues before marking this work verified.');
    if (review.limitations.length) throw new ReviewError('The review snapshot is incomplete. Save it as reviewed and inspect the missing evidence.');
    const latestByCommand = new Map(review.checks.map(check => [check.command, check]));
    if ([...latestByCommand.values()].some(check => check.outcome === 'failed')) throw new ReviewError('A recorded check is still failing. Resolve it and rerun that check before verifying.');
  }
  store.saveRecord('completion_reviews', { id: agentId, fingerprint: review.fingerprint, decision: body.decision,
    acceptance: redact(acceptance), unresolved: redact(unresolved), checksReviewed: body.checksReviewed === true, reviewedAt: Date.now() } satisfies ReviewDecision);
  store.audit('completion_review', agentId, { decision: body.decision });
  return completionReview(deps, store, agentId, originalRequest);
}
