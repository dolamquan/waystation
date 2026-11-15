# Agent platform

Open **Architecture** in the sidebar. Its sections now cover the design, deployed agents, reusable capabilities, service connections, local environments, central secrets, sandboxes, evaluation, and activity. See [Secrets, sandboxes and evaluation](agent-evaluation.md) for credential reuse and agent quality workflows. Existing graph designs and resource/run history remain available.

## Build a research agent

1. In **Architecture design**, create an agent, give it a role, and select an API or supported coding brain. For an API agent using tools, select **Allow connected tools** or **Review each tool call**. Save the agent.
2. In **Secrets**, save your API key once. In **Connections**, select the project and add a **Tavily** connection using **Saved secret**, or enter a connection-specific key. The key field clears after saving. This section also stores HTTP authorization headers and PostgreSQL passwords; model keys remain in **LLM connections** in the design view.
3. In **Capabilities**, publish a **Tavily integration** using that connection. Configure the function name, search depth, result limit, and optional domain filters. Its enabled action is search. **Run capability test** makes a real request and may consume API credits.
4. Publish a **Skill** with research instructions and required function names, for example `tavily_search`. Publish a **Memory backend** using SQLite or PostgreSQL. PostgreSQL's explicit initialize/test action creates only its configured keyed-memory table; it does not provision a server or query arbitrary business tables.
5. Return to the agent in **Architecture design**. Under **Capabilities & deployment**, attach each exact published version. Select a deployment environment and press **Deploy agent**. Missing skill/tool dependencies, duplicate function names, incompatible policies, and blocked network hosts prevent deployment.
6. In **Agents**, open the deployment's **Chat** tab and send a task. Follow tool calls in **Runs & traces**, or open the run in **Agent activity**. Model, tool, memory, approval, output and error events share the same execution history.

Tavily uses the documented [Search endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/search): a server-side Bearer credential and a POST request. The model supplies only a validated query; saved search defaults remain operator controlled. No third-party SDK or Tavily account is provisioned automatically.

## Versions and deployments

An Architecture document is a draft with revision history. Each deployment stores an immutable graph snapshot, exact capability versions, model selection, and an environment snapshot. Publishing a new capability or changing a draft/environment does not update existing deployments. Explicitly attach a newer capability version and deploy again when ready. The previous deployment and its conversations remain available.

The **Agents** list covers deployments across all architectures and projects. Its detail view shows the actual bindings: model, harness, local server, tools, memory, skills, interfaces, state and trace storage. Graph resource connections still work alongside reusable capability attachments. Draft **Run agent** tests also expand the pinned capabilities.

**Pause deployment** blocks new chat messages, API submissions, and retries. Work already accepted into the queue continues. **Cancel run** stops one queued or active attempt. A retry uses that attempt's original graph, environment and conversation context, with current credential values. Retrying a failed chat turn can supply its missing assistant reply without silently modifying other successful turns.

## Harnesses and environments

- **API harness:** bounded model/tool loop with model-turn, tool-call and output-token budgets. OpenAI, Anthropic and compatible endpoint formats use the existing provider adapters.
- **Coding harness:** supported restrained Claude/Copilot runtime. Per-tool approvals remain enforced and link to **Session details**. Connected resources use a run-scoped MCP grant. Each chat turn starts a managed execution with bounded prior conversation/memory context; conversations persist in the platform. Model limits follow the coding runtime; the platform does not claim API-harness budget enforcement for those SDKs. Combined role/skills/resource instructions must fit the native 8,000-character instruction limit.

An environment describes the current local Waystation daemon. Its concurrency limit is 1–6, with a global limit of twelve active runs and at most one active run per deployed agent. The durable queue accepts up to 100 unfinished runs. Agents sharing an environment share its concurrency budget. State, conversations, accepted queue entries and traces use application SQLite. Artifacts use project files. Agent memory uses its selected backend and is scoped by environment, architecture, memory block, namespace and agent/shared setting.

**Configured endpoints** permits the saved model provider, tools, PostgreSQL and output endpoints. JavaScript tools run in QuickJS without Node/network/filesystem access. **Restrict to exact hosts** additionally checks each API-provider/HTTP/database/webhook host against an allowlist. Include all needed hosts without protocols, ports or wildcard patterns. This restriction is available for API harnesses; coding-runtime deployments are rejected in restricted environments because the platform cannot enforce their complete native networking behavior. Coding tools continue to use their explicit review policy.

Environment edits affect new deployments. The current daemon remains the execution server; this version does not provision cloud servers. Optional sandbox settings launch fresh local Docker containers or isolated JavaScript executions. Conversation/execution state and domain/application data are separate concerns: SQLite owns platform state, memory adapters own keyed memory, project outputs own artifacts, and explicit tools provide application/API access.

## Persistent chat

Agent chat uses the selected deployment's role, capabilities, permissions and memory. It is distinct from the architect conversation, which edits drafts. Create separate threads with **New chat**. Threads persist after browser and daemon restarts. A message creates a traced run; only one unfinished message is accepted per conversation. Up to ten previous successful turns, bounded to 40,000 characters with individual assistant context capped at 20,000, are supplied to the API harness. Failed/cancelled user turns are retained for inspection but excluded from successful conversation context. A thread supports 100 user turns before a new thread is required.

An in-flight execution is marked **Interrupted** after restart; it is not automatically replayed. Accepted queued work resumes. Interval triggers coalesce missed occurrences into one current attempt; their last failure is visible.

## Reusable capabilities and connections

Capabilities publish immutable versions:

| Kind | Actual configuration |
| --- | --- |
| Skill | Instructions and required tool function names; dependencies are checked at deployment. |
| Tool | Authored isolated JavaScript or a fixed HTTP action, input schema, timeout and optional authorization connection. |
| Memory | SQLite/PostgreSQL backend, namespace, scope, retention, entry/context limits, and database settings. |
| Tavily | Saved connection, enabled search function, basic/advanced depth, result count and domain filters. |

Installing skill instructions does not grant new runtime permissions or run installation commands. Custom tools can call other APIs, and can be tested before attachment. Tools have input-schema validation and bounded results/timeouts. PostgreSQL tests require your live database and permissions. Details of existing adapters and output/router/approval configuration are in [Agent resources](agent-resources.md).

Connection secrets are write-only and resolved by the daemon. Graphs, capability versions, deployment snapshots, architect metadata and exports contain references, not stored secret values. Known model/resource secrets are scrubbed from run records and tool results. Replacing a connection secret updates consumers using its stable reference. The existing local secret store is **not encrypted at rest**. Task, conversation, output and trace content are local application data.

## Triggers, traces and artifacts

The deployment **Triggers** tab supports scheduled intervals and authenticated webhooks. New triggers start disabled and run a saved task. Enable them explicitly. Webhooks ignore request-body task overrides; the token grants only invocation of that trigger's configured task. **Create webhook token** displays a token once. Send it in `Authorization: Bearer …` to the displayed `/agent/agent-platform/:id/invoke` path. Replacing it revokes the old token; only a hash is retained. Responses contain the submitted run id/status, not conversation history or secrets. The existing server host/origin and local/private-network boundaries still apply. This feature does not expose a public internet endpoint.

All these triggers use the same queue as chat and explicit API work. An interval/webhook trigger refuses overlapping work from its own previous invocation. Configure intervals in minutes. There is no automatic retry of failed external actions: retry is explicit because tools, file writes and webhooks can have side effects.

Run details show deployment version, source, elapsed time, usage, events, errors and approvals. Trace events are appended separately from the bounded recent-event preview. **Download trace** exports the complete available event trail. **Download artifact** reads the recorded output file through the project path resolver; files outside the project or missing files are refused. Token usage is reported; this version does not invent cost estimates for models without a configured price.

Useful operator API endpoints (normal access-token and origin checks apply):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agent-platform?project=…` | Project capabilities, service connections, environments and deployments. |
| `POST /api/agent-capabilities`, `/:id` | Publish first/new capability version; updates require `expectedVersion`. |
| `POST /api/agent-capabilities/:id/test` | Test a saved version using `project`, `expectedVersion`, `input`, optional `initialize`. |
| `POST /api/agent-service-connections`, `/:id/key` | Create connection or replace its write-only secret. |
| `POST /api/agent-environments`, `/:id` | Create/update local environment; updates require `expectedRevision`. |
| `POST /api/architectures/:id/nodes/:node/deploy` | Deploy against `expectedRevision` and an optional `environmentId`. |
| `GET /api/agent-deployments`, `/:id` | List deployments or inspect one with conversations, runs and triggers. |
| `POST /api/agent-deployments/:id/status` | Set `active` or `paused`. |
| `POST /api/agent-deployments/:id/runs` | Submit `{ "text": "task" }` to a deployment. |
| `POST /api/agent-deployments/:id/conversations` | Create a persistent conversation. |
| `GET /api/agent-conversations/:id` | Read a thread with completed replies reconciled from runs. |
| `POST /api/agent-conversations/:id/messages` | Send `{ "text": "message" }`. |
| `POST /api/agent-deployments/:id/triggers`, `/:trigger` | Create a disabled trigger or set its enabled state. |
| `POST /api/agent-triggers/:id/key` | Create/rotate a webhook's scoped token. |
| `GET /api/agent-runs/:id/trace?after=0` | Read up to 200 events after a sequence number. |
| `GET /api/agent-runs/:id/artifacts/:index` | Read a recorded text/JSON output artifact. |

## Verification and boundaries

```powershell
npm test -- tests/agentPlatform.test.ts tests/agentResources.test.ts tests/agentRuns.test.ts tests/agentModelLoop.test.ts tests/architectureApi.integration.test.ts --maxWorkers=3
npm run build
node scripts/verify-agent-platform.mjs
```

The browser fixture simulates a compatible LLM and Tavily service locally. HTTP calls, JavaScript, SQLite memory, graph/deployment/conversation storage, queue, traces and file output are real. No paid-provider request or live PostgreSQL round trip is claimed. Remote infrastructure provisioning, automatic multi-agent/DAG scheduling, vector search, native package installation and automatic billing estimates remain outside this local version.
