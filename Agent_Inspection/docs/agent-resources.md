# Executable agent resources and activity

For versioned deployment, reusable skills/integrations, local environments and persistent agent chat, see [Agent platform](agent-platform.md).

Architecture blocks hold typed configuration. A run uses the saved configuration to execute connected tools, load and persist memory, validate input, and deliver the final result. Open **Architecture → Agent activity** to manage agents across all architectures.

## Configure a resource

Select a non-agent block, fill its configuration, and press **Save resource**. The canvas shows its backend or implementation. Blocks without settings show **Needs configuration**. Graph edits, undo/redo, JSON import/export, and architect edits preserve the configuration; secret values stay outside the graph.

| Block | Configuration | Working behavior |
| --- | --- | --- |
| Memory | SQLite or PostgreSQL, namespace, shared/per-agent scope, retention days, entry limit, context count | Loads recent values into agent context, supports keyed reads/writes, and saves successful conversations. |
| Tool: JavaScript | Function name, input JSON schema, function body, timeout | Executes your function with `input` and returns JSON. A test action executes it before attaching it to an agent. |
| Tool: HTTP | Function name, input schema, method, endpoint, timeout, write-only authorization | GET encodes arguments as query parameters; other methods send JSON. The daemon resolves authorization and returns a bounded response. |
| Output | Dashboard, project file, or webhook; text or JSON; optional JSON schema | Validates the result and actually saves or delivers it. |
| Input | Text or JSON, optional JSON schema | Validates a task before starting its connected agent. |
| Router | JSON field, equals/contains/exists condition, connected destination, fallback | Selects a downstream destination from the final result. Rules are evaluated as data. |
| Approval | Request text, decision timeout | Pauses final-result delivery. Operators approve or reject it in Agent activity. |

Tools and memory must connect directly to an agent, in either direction. Inputs point into agents. Result routing follows outgoing output/router/approval edges. Running an individual agent does not automatically start other agent nodes.

## Memory backends

**SQLite** uses the application's persistent local database. It needs no separate server. Namespace and block identity isolate values; **Separate values per agent** adds the agent node id to the scope. **Shared by connected agents** lets agents connected to the same memory block share values within that architecture.

**PostgreSQL** exposes host, port, database, database user, memory table, TLS, and password fields. TLS verifies the server certificate by default. Disabling TLS is available for local development. The password is saved separately and the form clears it after saving. Blank secret fields preserve an existing value.

Press **Initialize & test memory** to create the configured table if it is missing and verify an isolated write/read/delete. The database user needs access to that database and table, plus CREATE permission when initialization is required. The table holds `scope`, `key`, JSONB `value`, `updated_at`, and `expires_at`, with `(scope,key)` as the primary key. It is a keyed JSON memory store; it does not assume your application's existing business tables or schema.

Values expire according to their configured retention. Reads exclude expired values, and writes prune expired or excess entries within the scope. A resource test uses its own temporary namespace so it cannot evict real entries. Keys contain up to 200 characters; values are JSON up to 32 KB. Context loading includes up to 30 recent entries. Successful runs save a bounded input/result record automatically.

PostgreSQL values use [parameterized node-postgres queries](https://node-postgres.com/features/queries). Table identifiers are validated separately because SQL parameters represent values. Certificate verification follows the driver's [TLS configuration](https://node-postgres.com/features/ssl).

## Build and call tools

For a JavaScript tool, define the argument schema and write a synchronous function body:

```javascript
return { answer: input.n + 1 };
```

```json
{
  "type": "object",
  "properties": { "n": { "type": "number" } },
  "required": ["n"],
  "additionalProperties": false
}
```

JavaScript executes in a [QuickJS WebAssembly interpreter](https://github.com/justjake/quickjs-emscripten), with 32 MB memory, a bounded stack, and a CPU deadline of at most one second. Node APIs, imports, files, and networking are not exposed. Return a synchronous JSON value; promises are rejected. Use an HTTP tool for an external service.

HTTP tools use a fixed saved endpoint and method. HTTPS is required except for localhost HTTP. URL credentials, query parameters, fragments, and redirects are refused; GET arguments are added at invocation time. Store the complete authorization header (for example `Bearer …`) in the resource's write-only secret field. Responses are limited to 100 KB. The configured request timeout is 100–30000 ms. Input schemas are checked with [Ajv](https://ajv.js.org/api.html) before execution.

For an API-backed agent, select one of these tool policies:

- **Conversation only:** no callable tools. Connected memory context and output delivery still work.
- **Allow connected tools:** only functions from connected tool and memory blocks are exposed to the model.
- **Review each tool call:** each callable tool action pauses for operator approval in Agent activity.

OpenAI uses Responses function calls, Anthropic uses tool-use/tool-result messages, and compatible endpoints use chat-completion tool calls. Tool results return to the model for the next turn. Runs allow up to eight model turns and twenty tool calls, within the saved output-token budget. A provider request times out after two minutes; operator approval has its separately configured deadline.

Reviewed Claude/Copilot runs receive a separate `agent_resources` MCP grant. It exposes only `call_agent_tool`, `get_agent_memory`, and `put_agent_memory` for resources connected to that run's saved agent. The grant cannot edit diagrams or access another run. It stops working after the run finishes. The coding runtime's normal per-tool review still applies. Conversation-only coding runs receive no resource tools; the daemon still loads context and handles final delivery.

## Outputs, routing, and approvals

**Dashboard** retains the final response in run history. **File** creates an actual file inside the chosen project. A path such as `agent-results/{runId}.json` gives each attempt a unique destination. Files are never overwritten. Parent traversal, protected `.git` paths, and symlink escapes are rejected through the existing project path resolver. **Webhook** POSTs `{runId, agentId, output}` with its separately stored authorization value.

JSON outputs parse and validate the model result before delivery. A configured approval gate waits before downstream delivery; rejecting or expiring the decision fails that delivery path. A router reads dot-separated JSON fields and follows its matching connected destination or fallback. Routing and approval nodes do not launch another agent automatically.

Resource test actions execute the configured adapter: **Run tool test**, **Test memory**, and **Deliver test output** have real effects against the saved configuration. A failed destination marks a run failed and preserves its activity. Retry is explicit and can deliver outputs again under the new run id.

## Agent activity dashboard

The dashboard lists saved agent definitions across all architectures, their brains, connected-resource counts, and latest run states. You can configure an agent or start a task directly from its row. Search and architecture filters narrow both definitions and history.

History includes queued, running, needs-approval, completed, failed, cancelled, and interrupted attempts. A selected run shows its saved design revision, provider/model, elapsed time, token/tool usage, task, response, and timestamped model/tool/memory/output/error events. **Cancel run** aborts API work or stops the associated managed session. **Retry saved revision** creates a new attempt using the original graph snapshot, linked to its source run. Credential references resolve their current stored values, including replacement keys.

Pending output or API-tool decisions expose **Approve** and **Reject**. Native coding-runtime permissions link to **Session details**. In-flight runs are marked interrupted after a daemon restart, with their history retained; accepted queued work resumes. Active interrupted work is never silently replayed. At most twelve runs may be active, with one active attempt per saved agent. The dashboard lists the latest 500 run summaries; selected run details retain up to 500 bounded events.

Task text, outputs, and event details are local application data. Known project secrets are scrubbed from recorded activity and model tool results. LLM keys, database passwords, and resource authorization values use the existing local SecretStore outside the repository. That store is not encrypted at rest. HTTP and database credentials are never sent to the model as tool arguments or included in graph exports.

## Verification and limitations

```powershell
npm run typecheck
npm test -- tests/agentResources.test.ts tests/agentRuns.test.ts tests/agentModelLoop.test.ts tests/architectureApi.integration.test.ts --maxWorkers=3
npm run build
node scripts/verify-agent-resources.mjs
```

Tests exercise actual SQLite writes, bounded QuickJS code, local HTTP/webhook calls, filesystem output, tool-call wire formats, project-scoped credentials/MCP, approvals, cancellation, retry, and SQLite database restarts. Browser checks use a local simulated compatible LLM with the actual resource adapters. They do not use paid-provider credentials. PostgreSQL configuration and its driver are implemented, but a live PostgreSQL round trip requires a running server and was not exercised in the development environment; use **Initialize & test memory** to verify your own connection.
