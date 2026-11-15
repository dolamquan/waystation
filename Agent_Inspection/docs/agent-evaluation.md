# Agent secrets, sandboxes and evaluation

Open **Architecture**. **Secrets**, **Sandboxes** and **Evaluation** extend the [agent platform](agent-platform.md). These are local features backed by the Waystation daemon and application database.

## Save credentials once

1. Open **Secrets**, give the credential a name, select its type, and enter its value. Choose workspace scope to reuse it across projects, or current-project scope to limit where connections can reference it.
2. In **Connections**, choose **Saved secret** for Tavily, HTTP authorization or a PostgreSQL password. In **Architecture design → LLM connections**, choose a saved API key for a model connection.
3. Create the corresponding capability and attach its published version to the agent. A tool-capable agent can invoke that capability according to its saved policy. Saving a secret alone does not grant a tool to an agent.
4. Use **Replace value** in Secrets to rotate all connections referencing that value. **Revoke secret** removes its value; linked authenticated calls fail until a replacement is saved. Neither action changes the pinned capability or deployment version.

An API key is the raw key; Tavily adds its Bearer prefix server-side. A complete authorization header includes its scheme, for example `Bearer …`. Database passwords use the password type. Values are write-only, fields clear after successful saves, and graph/deployment exports contain references. Existing model and agent-service credentials also appear in the inventory. Replacing an individual connection's key overrides that connection's central reference; use Secrets for shared rotation.

The existing credential file lives outside the project in the application's local data directory. It is **not encrypted at rest**. Workspace/project scope controls which connections may bind a secret; it is not multi-user identity or OS isolation. Do not paste credentials into agent instructions, dataset examples or tool source. Known current values are redacted from agent traces, results and evaluation content; historical data is not a general-purpose secret scanner.

## Local sandboxes

The **Sandboxes** console runs code immediately and preserves its configuration, code, input and result. Select a project, backend, language and limits, then run. Inspect previous executions or cancel active work.

| Backend | Supported execution | Limits and access |
| --- | --- | --- |
| QuickJS | Synchronous JavaScript function body; receives `input`, returns a JSON value | 16–64 MB, 100–1000 ms; no Node, filesystem, imports or network APIs |
| Local Docker | JavaScript, Python or shell | 64–1024 MB, 100–30000 ms; nonroot user, no host mounts/network, read-only root, temporary workspace, CPU/process limits |

Docker Desktop/engine must be running. Pull `node:22-alpine` for JavaScript or `python:3.12-alpine` for Python/shell yourself; execution uses `--pull never`. Python receives an `input` variable and emits stdout. Shell receives JSON in `INPUT_JSON`. Both the daemon and an in-container timeout bound execution. Containers are removed after completion/cancellation. Each invocation starts fresh; there is no persistent sandbox filesystem or hosted sandbox provider.

To enable agent code execution, open **Environments**, configure an environment, and check **Enable a code sandbox for API agents**. Deploy the agent with that environment and a tool policy. The API harness exposes `execute_sandbox` only when permitted; review policy requires approval. Its executions link to the agent run and emit trace events. A deployment retains its sandbox settings when the environment is later edited. Coding harnesses cannot be deployed into this enforced sandbox environment; their native tools use their existing runtime and approvals.

## Datasets and evaluators

Under **Evaluation → Datasets**, create representative inputs and reference outputs, with test/train/validation splits. Add, edit or remove draft examples, then save a dataset revision. Import JSON arrays or JSONL (up to 200 examples and 800 KB), export JSONL, or inspect an older saved revision. Each example has a stable id. Run details can **Add run to dataset**, retaining a source-trace link; review the proposed reference before treating it as ground truth.

Under **Evaluators**, publish a quality check and a pass threshold from 0 to 1:

- Exact reference match, optionally ignoring letter case; surrounding whitespace is ignored.
- Contains text, using saved required text or each example's reference.
- JSON schema validation.
- Isolated JavaScript receiving `input.input`, `input.output` and `input.reference`. Return a number or `{ score: 0.8, comment: "Reason" }`.
- LLM judge using an existing project model connection and explicit criteria. Calls record token usage and may consume provider credits.

Test the saved version before using it. Publishing edits creates a new evaluator version. Invalid judge JSON, out-of-range scores and execution errors remain evaluation errors with no passing score. From a successful run's trace, **Evaluate output** adds a versioned score and feedback event to that run.

## Experiments and comparison

Under **Experiments**, choose a saved deployment, dataset revision, split, evaluators and 1–3 repetitions. The experiment snapshots the target definition/environment, dataset and evaluator versions. Up to 200 cases and ten evaluators are supported; four experiments can run concurrently, each submitting up to three active cases through the normal durable queue.

Each case starts with fresh memory and conversation context. File/webhook output delivery is suppressed; output is retained in the experiment and trace. Configured tools are disabled by default. Opting in executes real tools, including external API calls, under the deployment's tool/approval policy. Cancellation stops pending and accepted case work. Restarted active experiments become interrupted; **Retry saved experiment** explicitly uses their original snapshots and current connection credential values.

Inspect case inputs, references, actual outputs, scores, errors, tokens, elapsed time and run traces; export the complete experiment. Mean score summarizes available scores only, alongside completion/failure counts. Compare two experiments on the same dataset revision: rows align stable example ids and repetition numbers, including unmatched cases. Numeric deltas require the same evaluator id and version. Changed evaluator rules are not reported as regressions against older rules.

The workflow draws on LangSmith's [versioned datasets](https://docs.langchain.com/langsmith/manage-datasets-in-application), [evaluation types](https://docs.langchain.com/langsmith/evaluation-types), [experiment comparison](https://docs.langchain.com/langsmith/compare-experiment-results) and [sandbox concepts](https://docs.langchain.com/langsmith/sandboxes). This implementation does not connect to LangSmith or require a LangSmith account. Automated online evaluation rules, annotation queues, hosted sandbox sessions and infrastructure provisioning are outside this local version.

## Verification

```powershell
npm run typecheck
npm test -- tests/agentEvaluation.test.ts tests/agentPlatform.test.ts tests/agentResources.test.ts tests/agentRuns.test.ts tests/agentModelLoop.test.ts --maxWorkers=1
npm run build
node scripts/verify-agent-lab.mjs
```

The browser fixture simulates only the compatible model, LLM judge and research HTTP service. Secret references, QuickJS execution, datasets, evaluations, experiment queueing and traces use real application paths. Docker isolation arguments and cleanup are tested with an injected command runner. The local Docker engine was stopped during verification, so live container execution was not exercised. Paid providers and a live PostgreSQL server were not exercised.
