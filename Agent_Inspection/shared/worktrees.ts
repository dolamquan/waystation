export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly main: boolean;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

export interface WorktreeListing {
  readonly root: string;
  readonly worktrees: readonly GitWorktree[];
  readonly branches: readonly string[];
  readonly dirty: boolean;
  readonly hasCommits: boolean;
  readonly suggestedParent: string;
}

export interface NewWorktree {
  readonly root: string;
  readonly branch: string;
  readonly mode: 'new' | 'existing';
  /** Omitted uses HEAD; only used when creating a branch. */
  readonly base?: string;
  /** Omitted creates a sibling folder named after the repository and branch. */
  readonly path?: string;
}
