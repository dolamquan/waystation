import { existsSync, statSync } from 'node:fs';
import type { Agent, AgentEvent } from '../domain/types.ts';
import { extractChangedFiles, groupTurns } from './extract.ts';
import {
  commitsSince, diffStat, fileDiff, isIgnored, isTracked, probeRepo, readPreview, workingTreeStatus, type RepoInfo,
} from './git.ts';
import { OutputsPathError, resolveInsideCwd, type SafePath } from './pathSafety.ts';
import type { AgentOutputs, ChangedFile, FileDiff, GitOverview, StatusEntry } from './types.ts';

/** How far back the Outputs tab reads an agent's recorded events. */
export const MAX_OUTPUT_EVENTS = 3000;

export interface OutputsDeps {
  readonly agent: (agentId: string) => Agent | undefined;
  /** Oldest first, up to `limit`. */
  readonly events: (agentId: string, limit: number) => readonly AgentEvent[];
  readonly now?: () => number;
}

function requireAgent(deps: OutputsDeps, agentId: string): Agent {
  const agent = deps.agent(agentId);
  if (!agent) throw new OutputsPathError('Agent not found (it may have exited).');
  return agent;
}

const folderExists = (cwd: string): boolean => {
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory();
  } catch {
    return false;
  }
};

const caseless = (cwd: string | undefined) => cwd !== undefined && /^[a-zA-Z]:/.test(cwd);
const pathKey = (path: string, fold: boolean) => (fold ? path.toLowerCase() : path);

async function gitOverview(cwd: string | undefined, since: number | undefined): Promise<GitOverview> {
  if (!cwd) return { available: false, reason: 'No project folder was recorded for this session.' };
  if (!folderExists(cwd)) return { available: false, reason: 'This agent’s folder no longer exists.' };
  const probe = await probeRepo(cwd);
  if (!probe.ok) return { available: false, reason: probe.reason };
  const [tree, stat, commits] = await Promise.all([
    workingTreeStatus(cwd, probe.repo),
    diffStat(cwd, probe.repo),
    since !== undefined ? commitsSince(cwd, probe.repo, since) : Promise.resolve([]),
  ]);
  return {
    available: true,
    branch: probe.repo.branch,
    status: tree.status,
    statusTruncated: tree.truncated,
    diffStat: stat,
    commits,
    commitsSince: since,
  };
}

function withGitStatus(files: readonly ChangedFile[], status: readonly StatusEntry[], fold: boolean): ChangedFile[] {
  const codes = new Map(status.map((entry) => [pathKey(entry.path, fold), entry.code] as const));
  return files.map((file) => {
    const code = file.insideCwd ? codes.get(pathKey(file.path, fold)) : undefined;
    return code ? { ...file, gitStatus: code } : file;
  });
}

/** Everything the Outputs tab shows for one agent. Read-only for every tier. */
export async function agentOutputs(deps: OutputsDeps, agentId: string): Promise<AgentOutputs> {
  const agent = requireAgent(deps, agentId);
  const events = deps.events(agentId, MAX_OUTPUT_EVENTS);
  const since = agent.startedAt ?? events[0]?.ts;
  const git = await gitOverview(agent.cwd, since);
  const files = extractChangedFiles(events, agent.cwd);
  return {
    agentId,
    cwd: agent.cwd,
    generatedAt: (deps.now ?? Date.now)(),
    turns: groupTurns(events, agent.cwd),
    files: git.available ? withGitStatus(files, git.status, caseless(agent.cwd)) : files,
    eventsScanned: events.length,
    eventsCapped: events.length >= MAX_OUTPUT_EVENTS,
    git,
  };
}

const result = (path: string, kind: FileDiff['kind'], note?: string, text = '', truncated = false): FileDiff =>
  ({ path, kind, text, truncated, note });

async function previewOf(safe: SafePath, kind: 'untracked' | 'preview', note: string): Promise<FileDiff> {
  const preview = await readPreview(safe.abs);
  if (preview.binary) return result(safe.rel, 'binary', 'This is a binary file, so it isn’t shown.');
  return result(safe.rel, kind, note, preview.text, preview.truncated);
}

async function gitFileDiff(safe: SafePath, repo: RepoInfo): Promise<FileDiff> {
  const diff = await fileDiff(safe.root, repo, safe.rel);
  if (diff.text.trim()) return result(safe.rel, 'diff', repo.hasHead ? 'Uncommitted changes compared with the last commit.' : undefined, diff.text, diff.truncated);
  if (await isTracked(safe.root, safe.rel)) return result(safe.rel, 'clean', 'No uncommitted changes. Any edits have been committed (see Commits) or undone.');
  if (await isIgnored(safe.root, safe.rel)) return result(safe.rel, 'ignored', 'git ignores this file, so its contents aren’t shown here.');
  if (!safe.exists) return result(safe.rel, 'missing', 'This file doesn’t exist any more.');
  return previewOf(safe, 'untracked', 'New file, not yet added to git.');
}

/**
 * The current diff (or new-file content) of one file inside the agent's folder. Folders without git only
 * preview files this agent itself wrote, so the endpoint can't be used to read arbitrary files there.
 */
export async function agentFileDiff(deps: OutputsDeps, agentId: string, requested: unknown): Promise<FileDiff> {
  const agent = requireAgent(deps, agentId);
  if (!agent.cwd) throw new OutputsPathError('No project folder was recorded for this session.');
  const safe = resolveInsideCwd(agent.cwd, requested);
  const probe = await probeRepo(safe.root);
  if (probe.ok) return gitFileDiff(safe, probe.repo);
  const fold = caseless(agent.cwd);
  const own = extractChangedFiles(deps.events(agentId, MAX_OUTPUT_EVENTS), agent.cwd)
    .some((file) => file.insideCwd && pathKey(file.path, fold) === pathKey(safe.rel, fold));
  if (!own) return result(safe.rel, 'preview', `${probe.reason} Only files this agent changed can be previewed.`);
  if (!safe.exists) return result(safe.rel, 'missing', 'This file doesn’t exist any more.');
  return previewOf(safe, 'preview', `${probe.reason} Showing the file as it is now.`);
}
