/**
 * Starting line-ups for the New team dialog. Each member's focus goes into its briefing and into every
 * roster, and the lead assigns tasks by it, so the texts say concretely what each member owns.
 */

export type PresetVendor = 'claude' | 'codex';
export type PresetRole = 'lead' | 'worker';

export interface TeamPresetMember {
  readonly name: string;
  readonly role: PresetRole;
  readonly vendor: PresetVendor;
  readonly focus: string;
}

export interface TeamPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly members: readonly TeamPresetMember[];
}

const LEAD_FOCUS =
  'Plan and coordinate: split the goal into tasks that touch separate files, assign them by focus, agree on shared interfaces up front, review every finished branch against the goal, and call finish_team only when the work holds together.';

export const TEAM_PRESETS: readonly TeamPreset[] = [
  {
    id: 'build-review',
    label: 'Build + review',
    description: 'One member writes the code, another reviews and tests it before the lead signs off.',
    members: [
      { name: 'lead', role: 'lead', vendor: 'claude', focus: LEAD_FOCUS },
      {
        name: 'builder',
        role: 'worker',
        vendor: 'codex',
        focus: 'Implement the feature and its unit tests in your worktree. Keep changes small and focused, run the project\'s build and tests before marking a task done, and note which files changed and how to verify.',
      },
      {
        name: 'reviewer',
        role: 'worker',
        vendor: 'claude',
        focus: 'Review and harden: read the builder\'s worktree, look for bugs, missing edge cases, security issues and gaps in tests, write extra tests in your own worktree, and report concrete findings with file and line.',
      },
    ],
  },
  {
    id: 'parallel-builders',
    label: 'Parallel builders',
    description: 'Two builders work on separate parts of the codebase at the same time.',
    members: [
      { name: 'lead', role: 'lead', vendor: 'claude', focus: LEAD_FOCUS },
      {
        name: 'backend',
        role: 'worker',
        vendor: 'codex',
        focus: 'Server side: data model, business logic, APIs and their tests. Publish any interface the other builder depends on (types, endpoints, payloads) in a message before building on it.',
      },
      {
        name: 'frontend',
        role: 'worker',
        vendor: 'claude',
        focus: 'Client side: UI components, state, styling and their tests. Code against the interfaces the backend builder publishes; ask instead of guessing when a contract is unclear.',
      },
    ],
  },
  {
    id: 'pair',
    label: 'Pair',
    description: 'A lead that plans and reviews, and one builder that does the work. The cheapest team.',
    members: [
      { name: 'lead', role: 'lead', vendor: 'claude', focus: LEAD_FOCUS },
      {
        name: 'builder',
        role: 'worker',
        vendor: 'codex',
        focus: 'Do all implementation tasks: write the code and tests, run the build and tests in your worktree, and report what changed and how to verify when you mark a task done.',
      },
    ],
  },
];
