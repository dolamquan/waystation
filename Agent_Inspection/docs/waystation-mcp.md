# Waystation MCP

Coding agents can display results directly in Waystation. The built-in `waystation` server provides these tools:

| Tool | Purpose |
| --- | --- |
| `get_workspace` | Inspect project tiles, agent status and open consoles. |
| `list_tiles` / `get_tile` | Find tiles and read a note's content. |
| `create_note` | Save a Markdown note, such as results, a plan or a checklist. |
| `create_tile` | Create a blank, note, file or browser tile. |
| `open_file` | Display existing code, Markdown, notebooks, images or PDFs. |
| `open_preview` | Open a website or running local development server inside a browser tile. |
| `update_tile` | Change a title, note content or preview URL. |
| `show_tile` | Switch connected windows to the project canvas and bring a tile into view. |
| `close_tile` | Remove a tile; requires `confirm: true`. Closing a note removes its content. |
| `list_files` | Browse project folders to find files to display. |
| `get_sketch` | Read the project's planning sketch on the console-board canvas: architecture components, connections, notes and shapes, with ids, positions, a plain-language summary and the current revision. |
| `update_sketch` | Draw on or edit the sketch in one atomic batch: `add` (component, note, text or shape), `connect` (an arrow between two objects, with an optional label), `update`, `remove` and `title`. Pass the revision from `get_sketch`; a stale revision saves nothing. |

For example, ask your agent: “Save the test results as a note in Waystation,” “Open `reports/results.ipynb` in a tile,” “Show the app running on localhost:3000 in Waystation,” or “Sketch this repository's architecture on the Waystation canvas.” The agent starts development servers using its usual tools before calling `open_preview`.

### Sketching

Component variants are `client`, `loadbalancer`, `gateway`, `server`, `service`, `database`, `cache`, `queue`, `storage`, `external`, `stack` and `layer` (a dashed boundary; place blocks inside it). Positions are canvas pixels for an object's top-left corner; omit `x` and `y` and the object is placed below the existing content. Give objects your own `id` to connect them in the same batch:

```json
{ "expectedRevision": 0, "operations": [
  { "type": "add", "node": { "id": "api", "kind": "component", "variant": "service", "text": "Orders API" } },
  { "type": "add", "node": { "id": "db", "kind": "component", "variant": "database", "text": "Postgres" } },
  { "type": "connect", "from": "api", "to": "db", "label": "SQL" }
] }
```

Open console boards show the change within a couple of seconds; the operator can undo it. Removing an object removes its connections. Embedded images are returned without their image data. Sketches have at most 500 objects and 200 operations per call.

## Connections

New agents launched by Waystation automatically receive this server, including Claude Code, Codex, Copilot and configured ACP providers. Team members and CLI handoffs receive it too. The MCP name `waystation` is reserved for this connection. Existing sessions need to restart or reconnect to pick up new tools.

For independently launched coding agents, run from the Waystation checkout:

```sh
npm run mcp:configure
npm run mcp:configure -- --apply
```

The first command previews changes. The second adds `waystation` to the current user's Codex, Claude Code and Copilot CLI configurations. To select clients, pass `--agents=codex,claude` (or `copilot`). Existing settings and other MCP servers are preserved, and changed files receive a timestamped backup. Re-running the command is safe. Run it again if you move the checkout. See the client documentation for [Claude Code scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes) and [Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

Keep Waystation running, then restart or reconnect your external agent. No credential is written to agent configuration. The configured command starts `daemon/automation/waystation-mcp.mjs`, a Node stdio server that discovers the app through its private runtime `mcp.json`. It re-reads that file on each request so external bridges can reconnect after a daemon restart. The default project is the agent's working directory; pass an absolute `project` argument to target another project from an external client.

The daemon also exposes an authenticated Streamable HTTP endpoint at `http://127.0.0.1:4317/mcp` (or the configured daemon port). Local HTTP clients use the dedicated bearer token in the runtime `mcp.json`; the operator API token does not authenticate this endpoint. This stateless JSON transport supports MCP revisions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`; GET SSE subscriptions and session deletion return 405. The stdio bridge handles protocol negotiation for the configured coding clients.

## Persistence and behavior

Tiles and Markdown notes live in Waystation's SQLite database and remain after the app closes. Open windows synchronize with the daemon. Existing browser-only tiles import when the canvas opens; their old data is retained under the browser storage key `waystation-canvas-tiles-backup`. Planning sketches are stored by the daemon too (one per project, with a revision), so agents and every open window share them; the browser keeps a local copy as well. Canvas geometry and project view preferences continue to live in browser storage.

There can be at most 32 saved tiles and 100,000 characters per note. A full canvas refuses new tiles instead of discarding existing ones. Files remain on disk when their tiles close. Notes render Markdown without executing raw HTML, and can be edited in the app. Saving refuses to overwrite a note that changed since editing began.

Managed agents receive individual revocable grants restricted to their own project canvas. File tiles use Waystation's existing path checks, including symlink and directory traversal protection. Browser tiles accept HTTP and HTTPS websites and local development servers, and refuse Waystation itself. Websites run in isolated Chromium contexts, with no access to Waystation's session or desktop bridge. The existing notification and team MCP servers remain separate.

`show_tile` and creation tools with `reveal: true` request navigation in connected windows. They do not start the app or certify that a person saw the result. Set `reveal: false` to save a tile without navigating.

## Verification

```sh
npm run typecheck
npm test -- tests/waystationMcp.integration.test.ts tests/waystationMcpConfig.test.ts
npm run build
npm run mcp:verify
```

The final command uses an isolated daemon and headless Chrome. It checks actual tool-to-canvas navigation, note editing, updates from agents, file display, migration, reload and synchronization across two windows. Set `CHROME_PATH` if Chrome is installed elsewhere. It leaves the operator's running station untouched and saves a screenshot to `.mcp-verification/canvas.png`.
