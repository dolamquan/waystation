import { isAbsolute, join, relative } from 'node:path';
import { isManagedVendor } from '../../shared/agentProviders.ts';
import type { Agent } from '../domain/types.ts';
import { addWorktree, WorktreeError } from '../git/worktrees.ts';
import { UserError } from '../userError.ts';

/**
 * Moves an agent's task off a shared checkout: a new branch worktree, a new managed agent that
 * continues there from a summary of the original's recent activity, and the original stopped.
 * Used when two agents keep editing the same files.
 */
export interface MoveDeps {
  readonly agent: (agentId: string) => Agent | undefined;
  /** Validates, audits and launches, exactly like New agent. */
  readonly launch: (raw: unknown) => Agent;
  readonly stopAgent: (agentId: string) => Promise<void>;
  readonly handoffContext: (agentId: string) => string;
  readonly audit: (action: string, target: string, detail: unknown) => void;
}

type CreatedWorktree = Awaited<ReturnType<typeof addWorktree>>;

export interface MoveResult {
  readonly agent: Agent;
  readonly worktree: CreatedWorktree['worktree'];
  readonly warning?: string;
}

const BRANCH_PREFIX = 'waystation/';
const MAX_SLUG = 40;
const MAX_NAME = 80;

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
  return cleaned || 'agent';
}

/** The agent's folder inside the new worktree (it may work in a subfolder of the repository). */
function folderInWorktree(root: string, cwd: string, worktreePath: string): string {
  const inner = relative(root, cwd);
  return inner && !inner.startsWith('..') && !isAbsolute(inner) ? join(worktreePath, inner) : worktreePath;
}

function briefing(agent: Agent, branch: string, context: string): string {
  return [
    context,
    `You are continuing ${agent.name}'s task in a separate git worktree (branch ${branch}), because another agent was editing the same files in the shared checkout.`,
    `This worktree starts from the last commit: uncommitted edits made in ${agent.cwd} are not here. Check what is missing, redo what your task needs, and commit on this branch.`,
    'Continue the task.',
  ].filter(Boolean).join('\n\n');
}

async function createWorktree(cwd: string, branch: string): Promise<CreatedWorktree> {
  try {
    return await addWorktree({ root: cwd, branch, mode: 'new' });
  } catch (error) {
    if (error instanceof WorktreeError) throw new UserError(error.message);
    throw new UserError(`Could not create a worktree: ${(error as Error).message}`);
  }
}

export async function moveToWorktree(deps: MoveDeps, agentId: string, now = Date.now()): Promise<MoveResult> {
  const agent = deps.agent(agentId);
  if (!agent) throw new UserError('Agent not found (it may have exited).');
  if (!agent.cwd) throw new UserError('This agent has no known project folder to move from.');
  const branch = `${BRANCH_PREFIX}${slug(agent.name)}-${now.toString(36)}`;
  const { worktree, root } = await createWorktree(agent.cwd, branch);
  deps.audit('move_to_worktree', agentId, { branch, path: worktree.path });
  const launched = deps.launch({
    vendor: isManagedVendor(agent.vendor) ? agent.vendor : 'claude',
    cwd: folderInWorktree(root, agent.cwd, worktree.path),
    prompt: briefing(agent, branch, deps.handoffContext(agentId)),
    name: `${agent.name} (worktree)`.slice(0, MAX_NAME),
    ...(agent.model ? { model: agent.model } : {}),
  });
  if (agent.stopBlockedReason) {
    return { agent: launched, worktree, warning: `The original agent keeps running: ${agent.stopBlockedReason}` };
  }
  // The new agent is already running: a failed stop must not look like a failed move (a retry would duplicate it).
  try {
    await deps.stopAgent(agentId);
    return { agent: launched, worktree };
  } catch (error) {
    return { agent: launched, worktree, warning: `The original agent could not be stopped: ${(error as Error).message}` };
  }
}
