# Agent platform audit: architecture, tools, sandboxes, evaluation

Date: 2026-11-15. Scope: the agent builder (`daemon/architecture`, `shared/agent*`, `shared/architecture.ts`,
`web/src/components/architecture`) and its neighbours (`daemon/connectors`, `daemon/automation`,
`daemon/library/secretStore.ts`, `daemon/factory`). Five reviewers: three code auditors and two researchers.
The researchers compared the platform with OpenAI Agents SDK/AgentKit, Anthropic Managed Agents and the MCP
connector, AWS Bedrock AgentCore, Google ADK and Vertex Agent Engine, Microsoft Foundry, LangSmith, Braintrust,
Langfuse, Promptfoo, E2B, Modal, Vercel Sandbox, and the MCP 2025-06-18, 2025-11-25 and 2026-07-28 specs.

Status legend: **Fixed** (in this change), **Partly fixed**, **Open** (tracked, not yet done).
Severity: CRITICAL / HIGH / MEDIUM / LOW.

## Hosted workflow follow-up (2026-11-17)

The tables below record the earlier audit. The subsequent implementation in
[Hosted agent platform](hosted-agent-platform.md) supersedes D1 (agent handoffs now execute),
the managed-watchdog portion of D6 (whole-workflow time/step/token limits now apply),
and plaintext hosted credential storage (AES-256-GCM with a separately mounted key).
It also adds checkpoint resume with explicit uncertain-action replay, complete-workflow
deployment snapshots, evaluator-version checks on promotion, and organization-specific workers
behind an OIDC proxy and role-enforcing gateway. Hosted workers disable native coding sessions
and the legacy untracked model-test route. These changes do not close every finding below;
in particular, cost guarantees, parallel joins, HA, infrastructure egress controls and production
security/restore/load acceptance remain outside the verified implementation.

## How the platform worked before this change

```
Draft graph (revision n) ── Run draft (1 at a time) ──> trace
   └─ Deploy ──> Deployment vN, immediately ACTIVE (no gate)
         ├─ chat / API / interval / webhook (bound to vN forever)
         └─ pause / resume
   (separate, optional, gates nothing)
   Dataset + evaluators ──> Experiment(vN, tools stripped by default) ──> mean score
   Sandbox: Environment checkbox ──> hidden execute_sandbox tool (API agents only)
            + a standalone code playground
```

What the UI implied: Design → Sandbox → Evaluate → Deploy → Monitor. In the code, deploy went live at once,
evaluation was optional and blocked nothing, the sandbox was just a hidden tool, and "environments" were
configuration presets rather than stages.

## A. Tools, MCP and credentials

| # | Sev | Flaw | Evidence | Status |
|---|---|---|---|---|
| A1 | CRITICAL | Managed (Claude Code/Copilot) agents never see tool schemas. They get a `{id,name,type}` list in the system prompt and a generic `call_agent_tool(nodeId, input:any)` MCP shim, so the model has to guess arguments. This is the "an instruction is not a tool" problem. | `runs.ts:123`, `automation/tools.ts:17` | Fixed: a managed run’s MCP bridge serves each attached tool under its own name with its real description and input schema (`automation.toolsFor` reads the run’s tool manifest); the generic shim is gone |
| A2 | CRITICAL | Attached tools silently vanish under `chat-only`, which is the default policy. Tavily or HTTP tools deploy and run with zero tools, with no warning. | `runs.ts:134`, `AgentConfiguration.tsx:15` | Fixed: preview, deploy and run refuse “N tools attached but tool access is Chat only” (`toolGateway.assertToolAccess`) |
| A3 | HIGH | There is no MCP client or gateway for built agents. Library MCP servers only reach coding-CLI launches, and an API agent cannot use an MCP server at all. | `modelLoop.ts`, `mcpCatalog.ts:191` | Fixed: `mcpClient.ts` (Streamable HTTP, sessions, paginated `tools/list`, `tools/call`, `isError`, structured output). MCP capability: discover → allowlist → schemas pinned by hash → namespaced `server__tool` tools → drift blocks the call. OAuth and stdio remain open |
| A4 | HIGH | Approval is all or nothing per agent. `configured-tools` auto-runs POST/PUT/DELETE tools with credentials, and tools have no read/write classification. | `runs.ts:136`, `agentResources.ts:8` | Fixed: per-tool `readOnly` / `approval`; write-method HTTP and MCP tools ask by default; `review-tools` still asks for everything |
| A5 | HIGH | Secrets are stored in plaintext JSON, and a parse failure returns `{}`, so the next write deletes every secret. | `secretStore.ts:57-75` | Partly fixed: corrupt file quarantined, store goes read-only instead of overwriting, atomic writes with a rolling `.bak`. Encryption at rest still open |
| A6 | HIGH | Tool output goes to the model unlabeled and is truncated mid-JSON. Prompt injection from search results can drive write tools. | `modelLoop.ts:55` | Fixed: structural truncation with a `truncated` marker; system rule that tool output is untrusted data; write tools ask by default |
| A7 | HIGH | No guard against server-side request forgery (SSRF) on HTTP tools, webhooks or Postgres hosts. Cloud metadata and private LAN addresses are reachable. | `agentResources.ts:43`, `resources.ts:164` | Fixed: `assertResolvedHostAllowed` (literal and DNS-resolved addresses) before HTTP tools, webhooks, MCP and Postgres; loopback allowed for local dev; `WAYSTATION_ALLOW_PRIVATE_FETCH=1` opt-in. A DNS-rebinding window between check and connect remains |
| A8 | MEDIUM | Model input overrides tool `defaults`, so operator-fixed parameters (e.g. Tavily domains) can be changed by the model. | `resources.ts:182` | Fixed: `pinned` arguments are applied after model input |
| A9 | MEDIUM | Tavily exposes only `query`, so the model cannot choose topic, time range or depth, and the raw response is sent back verbose. | `platform.ts:123` | Fixed: real Tavily schema (topic, time_range, dates, depth up to the operator ceiling, max_results up to the limit), pinned domains, compact title/url/snippet/score results, read-only |
| A10 | MEDIUM | Tool budget overruns and argument parse errors fail the whole run instead of being returned to the model. Anthropic `tool_result` lacks `is_error`. | `modelLoop.ts:44,54,56` | Fixed |
| A11 | MEDIUM | No retry, backoff or `Retry-After` handling for 429/5xx from model providers. | `modelLoop.ts:28-30` | Fixed: two bounded retries on 408/409/425/429/5xx/529 honouring `Retry-After`; upstream bodies still never echoed (status-specific hints instead) |
| A12 | MEDIUM | Redaction is substring-only, with no minimum length and no derived forms (raw key vs `Bearer key`). | `resources.ts:56`, `secrets.ts:45` | Partly fixed: the model loop ignores values under 8 characters. Derived forms (base64, URL-encoded) still open |
| A13 | MEDIUM | Connector write approvals return `approval_required` as a success to API agents, which cannot wait for it. | `broker.ts:158` | Open |
| A14 | MEDIUM | Discord/WhatsApp tokens are marked connected without verification, and Tavily is saved without a test call. | `broker.ts:47`, `platform.ts:70` | Open |
| A15 | MEDIUM | The managed resource path bypasses run limits (`maxToolCalls`) and approvals. | `runs.ts:214` | Fixed: the managed bridge goes through the same gateway, budget and trajectory recording |
| A16 | LOW | Anthropic requests use `Authorization: Bearer` instead of `x-api-key`. | `modelLoop.ts:11` | Fixed: `x-api-key` for Anthropic keys |
| A17 | LOW | No structured audit of tool calls (name, argument hash, decision, latency). | `runs.ts:54` | Fixed: every run stores a structured `toolCalls` trajectory (name, source, redacted arguments, ok/error, duration, who approved) |

## B. Sandboxes and code execution

| # | Sev | Flaw | Evidence | Status |
|---|---|---|---|---|
| B1 | CRITICAL | The sandbox's role in the workflow is invisible. It is a checkbox on an environment that silently adds an `execute_sandbox` tool to API agents, and the Sandboxes page is a playground connected to nothing. | `runs.ts:144`, `AgentEvaluation.tsx:111` | Fixed: renamed “Code execution”; it is a `run_code` tool listed in the agent’s tool manifest and preview; executions link to their run |
| B2 | HIGH | Evaluator JavaScript hits the global limit of 4 concurrent sandboxes and fails spuriously. Every evaluator execution is also persisted forever. | `sandboxes.ts:36`, `evaluations.ts:66` | Fixed: evaluator JavaScript runs in memory (`evaluateJavaScript`), is not capped and not persisted |
| B3 | MEDIUM | Docker images are mutable tags with `--pull never`, and a missing image gives a generic error. | `sandboxes.ts:12` | Open |
| B4 | MEDIUM | QuickJS errors are swallowed, and QuickJS runs on the daemon's main thread. | `sandboxes.ts:48,59` | Partly fixed: evaluator code errors are surfaced (sanitized). QuickJS still runs on the main thread |
| B5 | MEDIUM | Isolation relies on Docker defaults only (no gVisor or seccomp profile). The "restricted network" is an allowlist of declared endpoints, not egress control. | `sandboxes.ts:54`, `platform.ts:129` | Open |
| B6 | HIGH | Factory checks spawn host shell commands that inherit the daemon's full environment. | `factory/checks.ts:12` | Open |

## C. Evaluation and release lifecycle

| # | Sev | Flaw | Evidence | Status |
|---|---|---|---|---|
| C1 | CRITICAL | Evaluation gates nothing. Deploy goes live immediately, and you have to deploy to evaluate. | `platform.ts:142` | Fixed: deploy creates a **candidate**; promotion to **production** needs a passing experiment on that exact version under the agent’s release policy, or an audited override reason |
| C2 | HIGH | No production pointer: every version stays active and triggers stay bound to old versions. | `platform.ts:146,191` | Fixed: one production version per agent; previous production is **retired** and can be rolled back; new triggers follow production |
| C3 | HIGH | Experiments strip tools by default, so they test a different agent than the one deployed. | `evaluations.ts:106` | Fixed: experiments default to live tools; `toolMode` is recorded and shown |
| C4 | HIGH | The headline "mean score" excludes failed cases, so failing candidates score higher. There is no pass rate. | `routes/agentEvaluation.ts:8` | Fixed: pass rate, pass@k, pass^k, mean with failures as 0, p50/p95, per-evaluator pass rate; compare reports regressions and fixes |
| C5 | HIGH | Graders can only see the final text. There are no tool-call or trajectory checks. | `agentEvaluation.ts:5` | Fixed: `regex`, `tool_called`, `tool_not_called`, `trajectory` (exact/in-order/any-order with precision and recall), `max_tool_calls`, `latency` |
| C6 | HIGH | A missing run throws inside the experiment tick and stalls every experiment. `grade()` rejections are never caught. | `evaluations.ts:98,102` | Fixed: each experiment and each case is isolated; grading rejections are caught |
| C7 | HIGH | Experiment cases run one at a time per deployment and starve live traffic. | `runs.ts:88` | Fixed: experiment runs use their own scheduler lane |
| C8 | HIGH | No cost tracking or budget on runs or experiments. | `runs.ts:160` | Open |
| C9 | MEDIUM | "Add run to dataset" uses the run's own output as the reference and accepts failed runs. | `evaluations.ts:41` | Fixed: failed runs need a written reference; the observed tool trajectory becomes `expectedTools` |
| C10 | MEDIUM | No replay with recorded tool outputs. | `runs.ts:67` | Open |
| C11 | MEDIUM | Thin audit: pause/resume and dataset, evaluator and experiment changes are not audited. | `platform.ts` | Partly fixed: promote, rollback, override, status changes, dataset/evaluator publishes and experiment starts are audited |
| C12 | MEDIUM | Whole-table scans on every tick and full definition snapshots on every run. | `evaluations.ts:74`, `runs.ts:78` | Open |
| C13 | LOW | The factory is a second, unrelated "pipeline" that uses the same vocabulary. | `daemon/factory` | Open |

## D. Agent definition and creation

| # | Sev | Flaw | Evidence | Status |
|---|---|---|---|---|
| D1 | CRITICAL | The canvas does not execute as drawn. Agent→agent edges are decorative, and the shipped "Builder → Reviewer" template never runs the reviewer or reaches the output. | `runs.ts:170`, `architecture.ts:88` | Partly fixed: the starter executes as drawn (agent → human review → output); agent→agent edges are flagged in workflow checks. Handoffs still open |
| D2 | CRITICAL | The architect chat launches a coding agent with unrestricted file and shell access in the project, guarded only by a prompt. | `routes/architecture.ts:76` | Fixed: architect chat validates vendor/model and runs under `review-tools` with interception, so every tool call needs approval |
| D3 | CRITICAL | Memory (including model-written values) is injected into the system prompt, creating a persistent prompt-injection channel. | `runs.ts:119` | Fixed: memory goes in a delimited user-role context message, never the system prompt |
| D4 | HIGH | No input/output guardrails. | — | Open |
| D5 | HIGH | Output schema enforced only after the run, by prompt text. | `runs.ts:118` | Open |
| D6 | HIGH | Hitting a limit fails the run and loses the partial work. Managed runs ignore all limits and have no watchdog. | `modelLoop.ts:44,70`, `runs.ts:224` | Partly fixed: an exhausted tool budget is a model-visible error and the model gets a final no-tools turn; managed-run watchdog still open |
| D7 | HIGH | No handoffs or agents-as-tools. | — | Open |
| D8 | HIGH | No schema version or migrations, and corrupted rows are silently dropped. | `db.ts:198` | Open |
| D9 | MEDIUM | Stale `run` objects saved across awaits can overwrite a concurrent cancel. | `runs.ts:101-168` | Open |
| D10 | MEDIUM | No delete or archive for workflows, deployments, runs or triggers, and caps count across all projects. | `store.ts:21` | Open |
| D11 | MEDIUM | The `/nodes/:node/test` endpoint is a second execution path with no tools, trace or network checks. | `routes/architecture.ts:31` | Open |
| D12 | LOW | Mojibake in user-visible strings ("harness?s", "Starting?"). | `runs.ts:125`, `AgentConfiguration.tsx:69` | Fixed |

## Target lifecycle

```
Build ──> Test (draft run, full trace + tool trajectory)
   └─ Publish candidate vN ──> Evaluate (dataset × graders, real tools, k trials)
         └─ Release gate (pass rate ≥ policy, no regression vs production)
               └─ Promote ──> Production (triggers/webhooks/chat follow it) ──> Rollback
   Failing production run ──> "Add to dataset" (input + observed trajectory) ──> next candidate
```

## What changed (implementation map)

| Area | Where |
|---|---|
| Tool manifest (one source of truth for names, schemas, read/write, approval) | `daemon/architecture/toolGateway.ts` |
| Gateway dispatch, approval, trajectory, managed bridge | `daemon/architecture/runs.ts` (`invokeTool`, `toolManifest`, `callResource`), `daemon/automation/automation.ts` |
| MCP client and capability publishing | `daemon/architecture/mcpClient.ts`, `daemon/architecture/platform.ts` (`publishCapability`, `discoverMcp`) |
| Pinned arguments, MCP dispatch, Tavily shaping, outbound guard | `daemon/architecture/resources.ts`, `daemon/library/urlGuard.ts` |
| Model loop: auth, retries, tool errors, final turn, untrusted context | `daemon/architecture/modelLoop.ts` |
| Release lifecycle and gate | `daemon/architecture/platform.ts` (`gate`, `promote`, `rollback`, `releases`, `saveReleasePolicy`) |
| Evaluation stats, graders, robustness | `shared/agentEvaluation.ts` (`experimentStats`, `regressions`, `trajectoryScore`), `daemon/architecture/evaluations.ts` |
| Secret store data-loss fix | `daemon/library/secretStore.ts` |
| Tests | `tests/agentToolGateway.test.ts` (new), `tests/agentModelLoop.test.ts`, `tests/secretStore.test.ts`, `tests/urlGuardInternal.test.ts`, updated run/platform/evaluation tests |

New API routes: `GET /api/architectures/:id/nodes/:node/releases`, `POST …/release-policy`, `GET /api/agent-deployments/:id/gate`,
`POST /api/agent-deployments/:id/promote`, `POST /api/agent-deployments/:id/rollback`, `POST /api/agent-service-connections/:id/discover`.

## Adding tools without writing code

Operators should never need to know the order "connection → capability → attach", and never write tool code by hand.
`daemon/architecture/toolBuilder.ts` turns intent into an attached tool in one step:

| Operator chooses | What happens | Code written by the operator |
|---|---|---|
| Search the web | Paste a Tavily key once (or pick a saved one); the typed `web_search` tool is published and attached | None |
| Connect an MCP server | Pick a preset (Context7, DeepWiki, GitHub, Tavily, Hugging Face), a server from the Library, a saved connection, or paste a URL. Tools are listed *before* anything is saved; tick the ones to allow; definitions are pinned and attached | None |
| Describe a tool | A model connection writes the tool (name, description, input schema, and either sandboxed JavaScript or an HTTP call). The platform validates the schema, test-runs JavaScript on the model's own sample input, and feeds failures back for up to two repairs. The operator reviews the arguments, test result and code, can ask for changes, then adds it | None |
| Run code | Turns on `run_code` for the agent (`runtime.codeExecution`), also available in draft test runs | None |
| Advanced | The original HTTP and JavaScript editors remain for experts | Optional |

Adding a tool to a "Chat only" agent switches it to tool access and says so, instead of failing later. Routes:
`GET /api/agent-tools/catalog`, `POST /api/agent-tools/mcp/probe`, `POST /api/agent-tools/generate`,
`POST /api/architectures/:id/nodes/:node/tools`, `POST …/tools/remove`. Tests: `tests/agentToolBuilder.test.ts`.

## Environment note: endpoint security and MCP

On the development machine, AVG’s web shield intercepts plain-HTTP requests that carry MCP headers
(`mcp-protocol-version`, `mcp-session-id`) and corrupts the response framing (`HPE_INVALID_CHUNK_SIZE`). Any compliant
MCP client is affected, not only Waystation. If a local MCP server fails with that error, exclude it from the web shield
or serve it over HTTPS. The MCP tests use an in-process transport so they do not depend on the machine.

## Remaining work, in priority order

1. Encryption at rest for secrets (DPAPI / OS keychain / KMS adapter) (A5).
2. Handoffs and agents-as-tools, plus a graph executor, so multi-agent canvases run as drawn (D1, D7).
3. Guardrails and a native structured-output repair loop (D4, D5).
4. Cost tables, run and experiment budgets, and a watchdog for managed runs (C8, D6).
5. MCP OAuth (Protected Resource Metadata, PKCE, RFC 8707) and per-run sandboxed stdio servers (A3 follow-up).
6. Connector approvals that API agents can wait on (A13); verified connector tokens (A14).
7. Indexed storage, retention and schema migrations (C12, D8, D10); replay with recorded tool outputs (C10).
8. Docker image digests and a stronger container runtime (B3, B5); scrubbed environment for factory checks (B6).
