# Software factory, first version

Open **Software factory** in the workspace sidebar. A factory connects a repository to a reusable crew, a workflow, and required checks. Definitions and work items are saved in the local SQLite database.

## Set up and run

1. Create a factory with the root path of an existing Git repository that has at least one commit.
2. In **Agents**, choose the provider, model, and instructions for the planner, builder, and reviewer. These use the existing managed-provider integrations and their sign-in.
3. In **Workflows**, configure at least one meaningful project check, for example `npm test` or `npm run build`. Commands execute in the work item's worktree with the local shell. Set plan approval, optional review, the automatic repair limit, and the time limit for each agent stage/check.
4. In **Settings**, save conventions and project context. Settings changes apply to new work items. Existing items retain their original configuration version.
5. Choose **New work**, describe the requested change and acceptance criteria, then **Queue work**. Queueing does not launch agents.
6. Open the item and choose **Start work**. When enabled, a planner investigates and returns a plan. **Approve plan & build** explicitly permits implementation.
7. The builder implements in an isolated Git worktree. The engine snapshots a candidate revision and executes the required checks. Failures return to the builder within the configured repair budget; exhausted budgets require your attention.
8. After passing checks, the optional reviewer evaluates the candidate. Review findings are advisory and remain in **Runs**. Inspect the change, evidence, and acceptance criteria before choosing **Accept candidate**.
9. **Merge accepted branch** asks for explicit confirmation and merges into the original base branch. It refuses stale candidates, a moved target branch, a dirty tracked checkout, protected configuration changes, and unsafe/conflicting merges. The branch remains available for manual delivery.

Worktrees contain committed source files, not your checkout's uncommitted changes or installed dependencies. The builder must prepare any dependencies needed in its worktree; check commands can also include explicit setup. Git worktrees isolate file changes; they are not an operating-system security boundary. Tool permissions retain the existing provider behavior.

## Sections

| Section | Purpose |
| --- | --- |
| Overview | Current work, decisions, delivery counts, and the configured process |
| Work | Queue, search, status filters, and work-item details |
| Agents | Persistent role definitions for planning, implementation, and review |
| Workflows | Required commands, stage options, repair limit, and time limits |
| Quality | Latest recorded check results across work items and failures to investigate |
| Settings | Factory identity, repository, and shared project context |

Each work item opens on **Workflow**, alongside **Brief**, **Plan**, **Runs**, **Changes**, **Checks**, and **Activity**. Checks preserve command output and the exact candidate revision. Earlier validation results remain inspectable after retries. Live managed agents link to their existing details drawer; completed attempt summaries remain in the work item. Pending plans, acceptance decisions, and blocked items also appear in **Needs attention**.

## Workflow architecture and live progress

**Overview** shows a connected workflow map, stage owners, human approval gates, and the bounded repair route from failed checks back to the builder. Use **Workflow view** to follow current work, inspect a particular work item, or examine the current factory configuration. Existing work uses its saved configuration; changing factory defaults does not redraw its recorded process. Disabled planning/review stages are omitted and explained.

Select a stage to inspect its purpose, provider/model, required commands, or linked agent. In a work item's **Workflow** view, **Inspect plan**, **Inspect runs**, **Inspect checks**, and **Inspect brief** open the related evidence. Selecting a stage does not execute it. **Follow current stage** restores automatic stage selection.

Progress is the number of completed configured stages. It does not estimate percentage of effort or remaining time. Plan approval, acceptance, and delivery stay separate; acceptance alone never counts as delivery. Paused, blocked, and cancelled runs preserve their actual interrupted stage, including the check runner.

The **Assigned agents** roster appears in Overview, Agents, and each work item's Workflow view. It links attempts to actual session IDs and shows agent names, providers, reported models, activity, elapsed assignment time, and permission waits. Missing sessions are labeled as awaiting updates, not as working. A disconnected feed is marked as last received state. The Agents section still provides the separate reusable role editors.

Validation shows the current check and recorded-check count. If a candidate changes after validation, its passing results are retained for inspection but labeled as needing revalidation. They no longer complete the validation/review stages or contribute to current Quality totals and pass rates.

## Lifecycle and recovery

The engine controls transitions; agent completion alone cannot satisfy a check or approve a plan/candidate. Acceptance records your decision rather than running additional checks. Changing a tested workspace invalidates acceptance and requires validation again. Commands that modify tracked files also invalidate their own candidate.

Pause and cancel stop the current assignment or check. Cancellation preserves the branch and records. Resume is explicit, may launch a new agent attempt, and never bypasses an unapproved plan. Timeouts and launch failures become visible blocked states. On daemon restart, active runs recover paused; saved plans, definitions, workspaces, decisions, and evidence remain available. Uncertain work is not automatically replayed.

The first version uses a single managed agent for each role and a fixed configurable lifecycle. Custom stage graphs, team-backed stages, schedules/webhooks, shared resource grants, model benchmarks, and automatic configuration improvement are future extensions. Quality shows recorded evidence, not a correctness guarantee or unmeasured performance claims.

## Verification

Run the backend and HTTP tests:

```powershell
npm test -- tests/factoryEngine.test.ts tests/factoryChecks.test.ts tests/factoryApi.integration.test.ts
```

Run the browser verification after a production build:

```powershell
npm run build
node scripts/verify-factory.mjs
```

The browser verifier starts an isolated local server and temporary Git repository. It uses the real API, SQLite persistence, Git worktrees, command checks, acceptance, and merging, with deterministic agent completions. It does not invoke paid models or establish live provider/model quality. It verifies all six factory sections, all six work-item views, configuration editing, work search, operator controls, multiple-factory scoping, attention navigation, and desktop/mobile overflow and scrolling. Artifacts are written to `.impeccable/factory/`; desktop/mobile review captures are in `.impeccable/review/`.

Run all existing regressions with `npm test -- --maxWorkers=4`, and type checking with `npm run typecheck`.

The visibility refinements have additional state tests in `tests/factoryWorkflowState.test.ts` and a controlled browser workflow:

```powershell
npm run build -- --outDir ../.impeccable/factory-polish/build
node scripts/verify-factory-visibility.mjs
```

This uses an isolated build and test server, so it does not replace the bundle or restart agents in an already-running Waystation. Captures and test reports are saved under `.impeccable/factory-polish/`. The browser covers working/waiting/missing agents, saved versus current workflow versions, live commands, repair loops, interruptions, invalidated evidence and all factory/detail sections at desktop, tablet and mobile sizes.

### Initial verification record

- Factory engine, real command runner, and HTTP API: 33 tests passed, including pause-race prevention and delivery pinned to the accepted commit.
- Complete Waystation regression suite: 1,359 tests passed across 120 files with four workers. The saved JSON report is `.impeccable/factory/regression.json`.
- Browser: 22 checks passed, including each factory section, each work-item view, real validation and delivery, operator controls, multiple factories, selected-factory persistence across console navigation, reopening persistence, and desktop/mobile scrolling. The saved report is `.impeccable/factory/results.json`.
- TypeScript checking and production build passed.
- The browser and lifecycle suites use deterministic agent completions. Live provider execution and model output quality were not exercised.

### Workflow visibility verification record

- Factory workflow state, engine, command runner and HTTP API: 66 tests passed with one worker. The run covers interrupted validation, candidate invalidation, saved configurations and live session state.
- Complete regression suite: 1,436 tests passed; report: `.impeccable/factory-polish/regression.json`. Three additional workflow-activity tests were added afterward and passed in the 66-test factory run.
- Visibility browser verification: 22 checks passed, including all six factory sections and seven work-item views at desktop, tablet and mobile widths; report: `.impeccable/factory-polish/results.json`.
- Existing factory browser regression: another 22 checks passed; report: `.impeccable/factory-polish/legacy/results.json`.
- TypeScript checking and production builds passed. Browser tests use deterministic agent sessions with real API, SQLite, Git and shell execution; live model output quality was not tested.
- Independent visual verdict: **ship**, with all three requested fixes scored resolved (invalidated evidence, current activity and duplicate workflow summary).

After rebuilding, refresh Waystation to load the interface. If the daemon is still running an earlier backend, the additional current-check and interruption metadata becomes available on its next safe restart. Existing records remain supported.
