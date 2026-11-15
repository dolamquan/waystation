# Software factory v2: implementation plan

Status: proposal · 2026-11-13 · Branch target: `feature/factory-v2` (off `main`)

## Goal

Turn the software factory into a **personal factory**: one developer, one machine, running work through coding agents they already subscribe to (Claude Code, Codex, Copilot, ACP agents). It should handle repository changes *and* general personal tasks. We borrow the useful ideas from Mastra Factory (configurable stages, intake, triage, signals, a knowledge base), but keep our own provider layer.

### Non-goals

- Hosted or multi-user deployments, GitHub Apps, Postgres or cloud sandboxes.
- Calling model APIs directly or handling vendor credentials. Agents keep launching through `daemon/managed/*Runner.ts`, so each vendor's official CLI or SDK uses the user's own sign-in. We never read, store or forward subscription tokens.
- Arbitrary DAG workflows. A pipeline is an **ordered list of stages plus a bounded repair loop**. That covers every flow we've identified, and a graph editor can come later if real demand shows up (YAGNI).

## Where we start

| Area | Today | Limitation |
| --- | --- | --- |
| Engine (`daemon/factory/engine.ts`, ~280 lines) | Hard-coded `planner → builder → checks → reviewer` with `requirePlan` / `review` flags | No new stage types; logic and validation are mixed in one class |
| Roles (`shared/factory.ts`) | Exactly three roles, one agent each | No triage, no parallel attempts, no cross-vendor review |
| Stage output | Plan/review are scraped from `assistant` events (`engine.ts:246`) | Unstructured and truncated; can't be trusted or rendered well |
| Workspace (`workspace.ts`) | Git worktree is mandatory, and `start` requires at least one check | Rules out personal and non-repository tasks |
| Intake | Manual "New work" form only | No canvas, folder, schedule or issue sources |
| Steering | Pause, cancel, resume | Can't add context to a running agent, although `ManagedRunner.send()` already exists |
| Knowledge | Free-text `context` field | No memory carried across work items |
| Quotas | None | Subscription rate limits look like stage failures |

Pieces we can reuse: `ManagedRunner.send()` (signals), `ManagedLaunch.mcpServers` (structured output bridge), `daemon/ops/schedules.ts` (scheduled intake), `daemon/automation/canvas.ts` (canvas intake), `daemon/teams/*` (team-backed stages), `daemon/api/routes/usageWindows.ts` (quota awareness), and the generic `loadRecords` / `saveRecord` store.

## Target design

### Data model (`shared/factory.ts`)

```ts
type StageKind = 'triage' | 'plan' | 'build' | 'checks' | 'review' | 'deliver' | 'custom';
type StageMode = 'auto' | 'manual';          // manual = gate that waits for the operator

interface StageAgent { vendor: ManagedVendor; model: string; instructions: string }

interface FactoryStage {
  id: string;
  kind: StageKind;
  name: string;
  mode: StageMode;                // gate *after* the stage produces output
  agents: StageAgent[];           // 0 for checks/deliver, 1..3 otherwise
  strategy?: 'single' | 'best_of' | 'consensus';   // how multiple agents combine
  readOnly?: boolean;             // triage/plan/review default true
  maxMinutes: number;
  checks?: FactoryCheck[];        // kind === 'checks'
}

interface FactoryPipeline {
  name: string;
  stages: FactoryStage[];         // ordered
  repair: { fromStage: string; toStage: string; max: number } | null;
}

type TaskKind = 'code' | 'personal';

interface FactoryDefinition {     // schemaVersion: 2
  id: string; name: string; schemaVersion: 2; revision: number;
  taskKind: TaskKind;
  repository?: string;            // required for 'code'
  outputFolder?: string;          // used for 'personal'
  pipeline: FactoryPipeline;
  intake: IntakeSource[];
  limits: { concurrentItems: number; perVendor: Partial<Record<ManagedVendor, number>> };
  context: string; createdAt: number; updatedAt: number;
}

interface FactoryItem {           // additions to today's shape
  stageIndex: number;
  stageOutputs: Record<string, StageOutput[]>;  // keyed by stage id, newest last
  signals: FactorySignal[];
  source?: { kind: IntakeSource['kind']; ref: string };
}

interface StageOutput {
  attemptId: string; kind: StageKind;
  summary: string; body: string;  // markdown
  findings?: { severity: 'blocker' | 'major' | 'minor'; text: string; file?: string }[];
  artifacts?: string[];           // personal tasks: files produced
}
```

Status becomes `{ phase: 'queued' | 'running' | 'gate' | 'waiting_quota' | 'blocked' | 'paused' | 'done' | 'cancelled'; stageId?: string }`. The UI derives labels from the stage name. We keep `FactoryStatus` as a computed compatibility value until the web UI has moved over.

### Engine split (`daemon/factory/`)

```
definition.ts     parse + validate v2 definitions, migrate v1 → v2
pipeline.ts       pure state machine: (item, event) -> { item, effects[] }
executors/
  agentStage.ts   launch, collect, combine (single / best_of / consensus)
  checksStage.ts  wraps runFactoryCheck (existing checks.ts)
  deliverStage.ts git merge (code) or publish outputs (personal)
bridge/
  factoryMcp.ts   stdio MCP server agents use to submit structured output
intake/
  canvas.ts folder.ts schedule.ts githubCli.ts
signals.ts        queue + deliver via ManagedRunner.send
quota.ts          vendor concurrency + rate-limit backoff
knowledge.ts      per-factory notes store + curator hooks
engine.ts         thin orchestrator: tick, actions, persistence, locking
```

`pipeline.ts` is pure (no I/O). The engine applies its effects (`launch`, `runChecks`, `stopAgent`, `transition`, `audit`), which lets us unit-test transitions exhaustively without agents.

### Invariants carried forward (must not regress)

1. Only the engine moves work between stages. An agent finishing a stage never approves, accepts or produces check evidence.
2. Evidence is pinned to the candidate revision. If the workspace changes, acceptance and passing results are invalidated (`requireEvidence`, `factoryWorkspaceMatches`).
3. A restart recovers active work as `paused`, and nothing is replayed automatically.
4. Each item records the configuration version it started with. Editing the factory affects only new items.
5. Merges keep the existing refusals: stale candidates, a moved base branch, a dirty checkout, protected configuration.

## Phases

Each phase can ship on its own, stays behind the existing Factory UI, and comes with tests (write the tests first; aim for at least 80% coverage on new modules).

### Phase 0: Refactor with no behaviour change (≈2–3 days)

- Extract `definition.ts` (validation from `saveDefinition`) and `pipeline.ts` (transitions) from `engine.ts`.
- Add the v2 types. Add `migrateV1(def)` to turn `requirePlan` / `review` / `checks` / `maxRepairs` into an equivalent `[plan(manual)?, build, checks, review?, deliver(manual)]` pipeline with `repair: checks → build`.
- On load, existing items keep their saved v1 `definition`, and the engine runs them through the migrated pipeline.
- **Exit criteria:** the existing `factoryEngine`, `factoryChecks`, `factoryApi.integration` and `factoryWorkflowState` tests and `scripts/verify-factory*.mjs` pass unchanged. Add table-driven tests for `pipeline.ts`.

### Phase 1: Structured stage output via a factory MCP bridge (≈3 days)

- `bridge/factoryMcp.ts`: a stdio MCP server, injected with `ManagedLaunch.mcpServers`, with tools `submit_plan`, `submit_investigation`, `submit_review`, `submit_result`, and `read_item` (brief, plan, previous findings). Scope it with a per-attempt token passed through `env`, the same pattern as the team bridge (`TOKEN_ENV`).
- The engine accepts a submission only for the current attempt and stage. Late or foreign submissions are rejected and audited.
- Fallback: if no submission arrives, use today's assistant-text scrape and label the output "unstructured".
- UI: render `StageOutput.findings` in **Runs** and **Plan**.

### Phase 2: Configurable pipelines and manual/auto gates (≈4 days)

- Editor: add, remove and reorder stages, pick the kind, set manual/auto, choose agents and the time limit. Validation rules: at most one `deliver`, and it comes last; `checks` must come after a `build`; the repair loop must point backwards; at most 10 stages.
- New stage kinds:
  - **triage**: read-only investigation (diagnosis, evidence, reproduction steps, assumptions) using `submit_investigation`. It runs before planning so the planner starts from evidence.
  - **custom**: a free-form read-only or read-write agent step (for example "update docs" or "write changelog").
- Generic gate action `approve-stage` replaces `approve-plan`; the old action stays as an alias.
- Workflow map (`FactoryWorkflow.tsx`) draws from `pipeline.stages` instead of fixed nodes.

### Phase 3: Personal task kind (≈3 days)

- `taskKind: 'personal'`: the workspace is a fresh folder under `factoryRoot/<item>/work`, optionally seeded from attachments or a source folder. No Git is required, and checks are optional.
- `deliver` for personal tasks copies the declared `artifacts` into `outputFolder` (no overwrite without confirmation) and/or creates a canvas note tile through `daemon/automation/canvas.ts`.
- Starter templates: "Research brief", "Script / automation", "Document draft", "Repo change" (the current default).
- Personal workspaces use `writeRoot` confinement the same way worktrees do.

### Phase 4: Intake sources (≈4 days)

```ts
type IntakeSource =
  | { kind: 'manual' }
  | { kind: 'canvas'; tag: string }                       // note tiles tagged e.g. #factory
  | { kind: 'folder'; path: string }                      // *.md files dropped into an inbox
  | { kind: 'schedule'; scheduleId: string; template: ItemTemplate }
  | { kind: 'github'; repo: string; label: string };      // via the user's `gh` CLI login
```

- Every source creates **queued** items only, and never starts them. An optional per-factory `autoStart` setting starts items up to `limits.concurrentItems`.
- De-duplicate on `source.ref` (tile id, file hash, issue number).
- GitHub runs through `gh issue list` and `gh pr create` under the user's own CLI login: no GitHub App and no stored token.
- The folder watcher ignores files over 64 KB and non-markdown files. Content is treated as untrusted data in the briefing, never as engine instructions.

### Phase 5: Signals (≈2 days)

- `POST /api/factory/items/:id/signal { text }`. If the current attempt's runner is waiting for input, deliver it with `ManagedRunner.send()`. If it's busy, queue it and deliver when the current turn ends. If no agent is running, attach it to the next stage's briefing.
- Record each signal in `item.signals` and `activity` with its delivery status.
- UI: a "Send guidance" box in the work item header and on the canvas agent tile.

### Phase 6: Multi-agent stages (≈4 days)

- `strategy: 'best_of'` (build): N agents (for example Claude and Codex) work in sibling worktrees. Checks run on each, and the operator picks a candidate at the gate (or it's auto-picked when exactly one passes).
- `strategy: 'consensus'` (review, plan): agents run in parallel read-only, and their findings are merged and de-duplicated. A blocker from any reviewer blocks auto mode.
- Optional `team` stage that delegates to an existing team in `daemon/teams` and maps the team's result back to a `StageOutput`.
- Per-vendor concurrency comes from `limits.perVendor`.

### Phase 7: Subscription-aware scheduling (≈2–3 days)

- `quota.ts`: classify runner errors that indicate a rate or usage limit (per runner: Claude SDK, Codex, Copilot). Move the item to `waiting_quota` instead of `blocked`, and retry using the reset time from `usageWindows` when available, otherwise with exponential backoff (5, 15, 30 minutes, max 3).
- Queue scheduling respects `concurrentItems` and per-vendor caps, so a backlog drains overnight without tripping limits.
- Overview shows "waiting for <vendor> limit reset at hh:mm".

### Phase 8: Knowledge base (≈4 days)

- `factory_knowledge` records: `{ id, factoryId, title, body, citations: { itemId, file?, commit? }[], updatedAt }`.
- `read_knowledge` / `propose_knowledge` tools on the factory MCP bridge. Agents can *propose* entries; proposals land in a review list (or are auto-accepted when the factory enables it).
- An optional `curator` custom stage after `deliver` summarises what was learned.
- Briefings include the top entries ranked by keyword match against the request (no embeddings in v2).

## API changes

| Route | Change |
| --- | --- |
| `POST /api/factory/definitions[/:id]` | Accepts v2; v1 bodies are migrated |
| `POST /api/factory/items/:id/action` | Adds `approve-stage`, `pick-candidate`; `approve-plan` kept as an alias |
| `POST /api/factory/items/:id/signal` | New |
| `GET/POST /api/factory/:id/knowledge` | New |
| `GET /api/factory/:id/intake` | New: source status and last poll |

All new inputs are validated at the route boundary with the existing `fields` / `string` / `number` helpers, or Zod if we adopt it for v2 definitions.

## Testing strategy

- **Unit:** `pipeline.ts` transition tables, `definition.ts` validation and migration, `quota.ts` error classification, intake de-duplication.
- **Integration:** extend `factoryApi.integration.test.ts` with a deterministic `FactoryHost` that can submit through the MCP bridge, send signals and simulate rate-limit errors.
- **Browser:** extend `scripts/verify-factory.mjs` with a personal-task flow, a custom pipeline, best-of-2 selection and signal delivery, at desktop and mobile widths.
- **Live smoke test (manual):** one real run each on Claude and Codex subscriptions, recorded in this doc.

## Risks

| Risk | Mitigation |
| --- | --- |
| Vendor terms for automated use of subscriptions | Launch only the official CLIs/SDKs under the user's login, never touch tokens, and keep human gates on by default. Re-check Anthropic and OpenAI terms before release |
| Rate limits stall queues | Phase 7: `waiting_quota` state, per-vendor caps |
| Refactoring the engine breaks v1 guarantees | Phase 0 is behaviour-neutral and gated on the existing test suites |
| Untrusted intake content (issues, inbox files) steering agents | Pass it as quoted data in the briefing; agents can't trigger gates; the operator approves by default |
| Parallel agents exhaust disk or CPU | Per-factory and per-vendor caps; clean up worktrees for unpicked candidates |

## Suggested order and rough size

Phase 0 → 1 → 2 → 3 delivers the core product change (about 2.5 weeks). Phases 4–8 are independent after that and can be prioritised by use: intake and signals give the most day-to-day value, multi-agent stages and knowledge the most differentiation.

## Open questions

1. Should personal tasks be a separate factory type, or can a single factory hold both code and personal items?
2. Is GitHub intake wanted in v2, or are canvas and folder intake enough for the personal focus?
3. Default for auto mode: should a new factory ship with every gate set to manual (safest) or with only plan and deliver manual (today's behaviour)?
4. Should the knowledge base be per factory or shared across all factories on the machine?
