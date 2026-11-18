# Architecture workspace

Open **Architecture** in the workspace sidebar to construct multipurpose agents, design how they work together, and discuss or edit the architecture with a dedicated architect chat. An agent can handle research, planning, writing, support, analysis, coding, or another role you define.

For executable memory, tools, outputs, and the cross-architecture dashboard, see [Agent resources and activity](agent-resources.md).

For versioned agent deployments, persistent chat, reusable capabilities, Tavily integration, environments and triggers, see [Agent platform](agent-platform.md).

Choose an existing project folder, then start with an empty workflow or the builder → reviewer example. The example is a design, not a running team. You can save multiple workflows per project.

## Design the flow

- Drag **Input**, **Agent**, **Router**, **Tool**, **Memory**, **Approval**, or **Output** from Components onto the canvas. Clicking a component adds it in the center of the view.
- Drag steps to move them. Positions snap to a 20-pixel grid. Drag the background to pan; use the zoom controls or **Fit workflow** to see the whole graph.
- Click **Connect**, then choose the source and destination. You can also start a connection with the small output port on a step. Select a connection to describe the handoff or condition.
- Select a step to edit its name and description. Agent steps also have role instructions and a brain configuration. Saving settings does not launch an agent; **Run agent** starts an explicit run with its connected resources.
- Click the background to edit the workflow title and goal.
- Delete the selected element with the toolbar or Delete key. Removing a step also removes its connections.
- Undo and redo restore the last 30 graph edits, including edits made by the architect. Keyboard shortcuts work while focus is in the diagram: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Delete, Escape, and arrow keys to move a selected step.
- **Export JSON** downloads the graph. **New workflow → Import JSON** validates a graph file and creates a separate workflow in the chosen project.

The editor uses Waystation's local SQLite database, so workflows, revision history, and the current architect session association survive reloads. The selected workflow is a browser preference. Designs support 200 steps and 400 connections. Feedback loops between different steps are allowed.

## Work with the architect

Choose a configured provider and model before the first message. For example:

> Add a human approval before the final response, with a rejected branch back to the builder.

> Should the researcher and reviewer share memory?

The architect is a normal Waystation-managed conversation. It receives instructions to read the current graph before discussing it or changing it. The selected element is included as context. It uses the same graph store as the editor, through three project-scoped MCP tools:

| Tool | Behavior |
| --- | --- |
| `list_architectures` | Lists workflow ids, titles, and revisions for the agent's project. |
| `get_architecture` | Reads a complete graph and its revision. |
| `update_architecture` | Applies an atomic batch of node, connection, or workflow-description edits. |

Every update must name the revision it read. A stale update fails without saving any of its edits; the architect must reread and reconsider it. The editor polls for graph and chat changes every 1.2 seconds. **Session details** opens the usual agent controls, including approvals and recovery. **Interrupt** stops the current turn. If a session has ended, sending another message starts a new architect with the existing diagram as context.

Design edits do not start work. Explicit runs execute the selected entry agent and its connected agent handoffs, routers, approvals and outputs. Tools and memory connect as attachments. Workflow steps are checkpointed, with bounded loops, timeout and token accounting. See [the hosted platform and execution contract](hosted-agent-platform.md) for recovery, production release gates and organization isolation. The local architect uses a managed provider with tool approvals; the hosted API architect proposes validated edits for explicit review without file or shell access.

## Construct and test individual agents

Select an **Agent**, write its role and boundaries, and choose its brain:

| Brain | Configuration | Test behavior |
| --- | --- | --- |
| Coding runtime as a multipurpose agent | Claude or Copilot, model, and tool policy | Starts a managed session using the saved instructions. Conversation-only blocks tool calls. Review-every-tool requires an operator decision for each tool call, even if Intercept is subsequently turned off. |
| LLM API connection | A project-scoped OpenAI, Anthropic, or compatible connection; optional model override and output limit | Runs bounded model/tool turns through the daemon, using only connected functions allowed by the saved policy. Connected resources handle memory and output delivery. |

Save the configuration, enter an **Agent task**, and press **Run agent**. Runs persist in **Agent activity**, with usage, logs, approvals, cancellation, and retry. A revision check prevents starting a configuration that changed before submission. API provider requests have a two-minute timeout, a configurable 64–4096-token output budget, and bounded model/tool turns. Managed runs link to **Session details** for native approvals. See [the resource and activity guide](agent-resources.md) for actual memory, tool, input, output, routing, and approval behavior.

Restrained coding-runtime tests currently support **Claude and Copilot**. Codex and other configured providers remain available for the architect conversation; they are disabled in the restrained-runtime picker because the application cannot enforce the same per-tool policy through those adapters. Restrained agents omit automatic Waystation/notification MCP tools; Claude also omits inherited user/project/local settings. Terminal handoff is blocked for these sessions because it cannot preserve the enforced restrictions. Restarting within Waystation preserves the runtime policy.

## LLM connections and keys

Use **LLM connections** above the diagram to add a named connection, provider, model id, and API key. Compatible endpoints use an explicit API base URL, supporting HTTPS or HTTP on localhost (including a keyless local server). Anthropic connections accept an optional workspace id for keys not scoped to one workspace.

Keys are write-only: the form clears them after saving, metadata only reports whether a key is present, and **Replace key** rotates a stored key without revealing it. The daemon stores values in Waystation's existing local `SecretStore`, outside the repository. That store is a local JSON file under the application's runtime directory; this feature does not add encryption at rest. Connection ids and non-secret runtime settings can appear in graphs, chat context, and exports. Raw keys entered in the connection form do not. When importing into another project, choose that project's own connection before testing.

OpenAI requests use the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), with server-side response storage disabled. Anthropic requests use the [Messages API](https://platform.claude.com/docs/en/api/messages/create), API version `2026-10-21`, and bearer authentication; unscoped keys can supply the workspace header described in the [authentication documentation](https://platform.claude.com/docs/en/manage-claude/authentication). Compatible connections use `/chat/completions`. Redirects are rejected, and upstream error bodies are not echoed to the browser. A request sends the configured role and test message to the chosen provider.

## API and validation

Operator endpoints use the normal access token and origin checks:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/architectures` | List workflow documents. |
| `POST /api/architectures` | Create from a project folder and an optional graph or `"starter"`. |
| `GET /api/architectures/:id` | Read graph, history availability, attached agent, and chat events. |
| `POST /api/architectures/:id` | Apply `operations` against `expectedRevision`. |
| `POST /api/architectures/:id/history` | Undo or redo against `expectedRevision`. |
| `POST /api/architectures/:id/chat` | Send a message or launch the workflow's architect. |
| `GET/POST /api/architectures/:id/connections` | List or create project-scoped LLM connections. |
| `POST /api/architectures/:id/connections/:connection/key` | Replace a connection's write-only key. |
| `POST /api/architectures/:id/nodes/:node/test` | Test a saved agent against `expectedRevision`. |
| `POST /api/architectures/:id/nodes/:node/run` | Start a durable individual run using the saved revision. |
| `GET/POST /api/architectures/:id/nodes/:node/resource` | Inspect credential status or save resource configuration and write-only secrets. |
| `POST /api/architectures/:id/nodes/:node/resource/test` | Execute the saved resource adapter's test. |
| `GET /api/agent-runs` | List activity across architectures. |
| `GET /api/agent-runs/:id` | Read a run's details and events. |
| `POST /api/agent-runs/:id/cancel`, `/retry`, `/decision` | Cancel, retry the saved revision, or decide a pending approval. |

Operations are `put_node`, `remove_node`, `put_edge`, `remove_edge`, and `describe`. Put operations replace the complete object. A batch is validated after applying all operations to a copy: missing endpoints, duplicate ids, duplicate connections, self-connections, unknown node kinds, and invalid coordinates fail atomically. The agent tools enforce the existing project grant before exposing or changing a workflow.

## Verification

```powershell
npm run typecheck
npm test -- tests/architecture.test.ts tests/architectureBrains.test.ts tests/architectureRuntime.test.ts tests/architectureApi.integration.test.ts tests/managed.test.ts tests/copilot.integration.test.ts tests/waystationMcp.integration.test.ts --maxWorkers=3
npm run build
node scripts/verify-agent-resources.mjs
```

The browser verification uses an isolated local daemon, simulated architect, and local simulated compatible LLM endpoint. It exercises real HTTP, MCP, credential storage, individual API-agent testing, persistence, manual editing, and undo paths without calling a paid model or changing live sessions. Adapter tests cover OpenAI and Anthropic request/response formats and enforced Claude/Copilot policies with mocked SDKs. Screenshots and results are written under `.impeccable/architecture/`. A live paid-model round trip is not covered by these checks. Additional resource/run verification is documented in [Agent resources and activity](agent-resources.md).
