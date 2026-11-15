# Interactive planning canvas

Choose **Canvas** on the console board to plan before opening an agent. Notes and reference material work with no running sessions. Rename the canvas at the top; the project selector keeps each project's ideas separate. Saved project boards remain reachable after their last agent exits.

## Create and arrange ideas

Use the left toolbar for sticky notes, free text, labeled shapes, pen drawings and arrows. Click empty space to place a note, text or shape; drag to draw with the pen or arrow. Choose sand, mint, rose or blue for authored objects.

Upload a raster image, drop a file onto the canvas or paste an image from the clipboard. PNG, JPEG, WebP and GIF files must be under 2 MB. Edit an image's description below it. Pasted plain text becomes a note. Image creation currently means upload, paste or drag and drop; there is no native image generation.

Select an object's frame or handle and drag to move it. Shift-click adds or removes objects from the selection; dragging a selected object moves the selected group. Drag the bottom-right grip to resize notes, text, shapes and images. Drawings and arrows can be selected and moved. Click empty space with Select active to clear the selection.

Drag empty canvas space to pan, or choose the Hand tool. Scroll over empty space to zoom around the pointer; Ctrl+scroll also zooms over objects and sessions. Ordinary scrolling inside a session stays with that session. The bottom controls zoom, reset to 100%, fit ideas and sessions, or tidy session tiles into a grid.

## Sketch an architecture

Open **Architecture components** in the left toolbar (or press **L**) for building blocks: client, load balancer, API gateway, server, service, database, cache, queue, storage, external/cloud, stack (a group of instances) and layer (a dashed boundary such as Frontend or Backend). Pick a block, then click the canvas to place it, or press Enter to place it in the centre. **Start from a layered web app** adds a ready-made example (clients, a load balancer, frontend and backend layers with services, and a database) below whatever is already on the canvas.

Double-click a block, or press Enter while it is focused, to rename it. Drag a layer or stack and the blocks inside it move with it. Layers sit behind session tiles, so they never cover a terminal.

Choose **Connect blocks** (or press **C**), then click one block and then another, or drag from one to the other, to draw an arrow between them. Connections stay attached as blocks move. Double-click a connection to label it (for example `HTTPS` or `SQL`); select it and press Delete to remove it. Removing a block removes its connections. Esc leaves the Connect tool.

Agents can read and draw on the same sketch through the [Waystation MCP](waystation-mcp.md) (`get_sketch`, `update_sketch`). Their changes appear on the board within a couple of seconds, with a notice, and Ctrl+Z undoes them like any other change.

## Browse websites inside a tile

Choose **New tile → Browser**, enter a website address or a local development server, then choose **Open page**. Public addresses default to HTTPS; `localhost:3000` defaults to HTTP. The tile runs a real Chromium page streamed from the local daemon, so sites with `X-Frame-Options` or `frame-ancestors` restrictions can load without embedding their documents in Waystation. The app's content security policy stays unchanged.

The toolbar provides back, forward, reload, an address field and a Go button. Click the page to type, follow links or scroll. Paste forwards plain text. **Ctrl+L** focuses the tile address; **Escape** leaves the page. Canvas shortcuts and pasted planning notes stay inactive while typing in the browser. Website prompts, alerts and confirmations appear inside the tile. Links requesting a new window open in the same tile.

Chrome or Microsoft Edge must be installed on the daemon's machine. For a custom installation, set `WAYSTATION_BROWSER_EXECUTABLE` to its executable path. Each tile has its own ephemeral browser context, separate from your normal browser profile, the other tiles and Waystation. The last URL persists with the tile. Live pages survive a UI reload or project switch, and close after five minutes without a viewer, when the tile closes or changes kind, or when the daemon shuts down. Cookies and history end with that live context.

Use **Open in your browser** in the toolbar for file uploads/downloads and workflows requiring your normal profile. Links that use a new window for a POST or an opener-based sign-in handshake may need that option too. The streamed page provides keyboard input but does not expose the website's DOM to the host screen reader.

Verify the browser implementation with `npm test -- tests/browserTiles.integration.test.ts tests/canvasTiles.test.ts tests/waystationMcp.integration.test.ts` and `node scripts/verify-browser-tiles.mjs` after `npm run build`. The UI verifier starts an isolated daemon and Chrome sessions, leaving an existing station untouched; screenshots are saved under `.browser-verification/`.

## Keyboard controls

Canvas shortcuts apply while focus is on the canvas or its controls. Typing in a text field, terminal or dialog keeps its normal behavior.

| Keys | Action |
| --- | --- |
| V / H | Select / Hand |
| N / T / R | Choose sticky note / text / shape; press Enter to place it near the view center |
| P / A | Pen / arrow; draw with the pointer |
| C | Connect blocks: click (or drag from) one block, then another |
| L | Open or close the architecture components |
| Enter or F2 on a focused block | Rename it (Enter or Esc finishes) |
| Arrow keys on a focused object | Move by 10 canvas units |
| Shift+arrow keys on a focused note, text, shape or image | Resize by 10 canvas units |
| Arrow keys on a focused resize grip | Resize by 10 canvas units |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Undo / redo authored canvas changes |
| Ctrl+D | Duplicate selected authored objects |
| Delete / Backspace | Remove selected authored objects |
| Escape | Clear selection, return to Select and close the sharing panel |
| + / − / 0 | Zoom in / zoom out / reset view |

Command can replace Ctrl for undo, redo and duplicate. Undo history keeps up to 40 previous authored states in the current session. Session tiles retain their existing title-bar controls: arrows move them, and Shift+arrows resize them.

## Local saves and recovery

Boards save automatically, separately for each project, with a visible save status: first in this browser's local storage, then to the local Waystation daemon, which keeps the copy agents read and edit. Nothing leaves the machine. Export a copy for backup or transfer; **Not saved** means the browser could not persist the latest changes, and **Saved in this browser** means the daemon was unreachable (the board catches up when it returns). The **All projects** view has no shared copy.

When another window or an agent changes the same board while local work is pending, saving pauses for a choice: **Keep my version** or **Use other version**. Use **Export my copy** first to preserve both. Clean incoming changes appear automatically.

If saved data cannot be read, the original data stays preserved and editing is blocked. Choose **Download saved data** for a recovery copy, then **Start a new board** and confirm **Replace board** to replace it with an empty board.

## Share or hand off

**Share board** offers an editable `.waystation.json` file, a Markdown brief and a PNG snapshot. JSON includes the authored objects, their layout and embedded raster images. Importing a board adds its objects to the current board with new IDs. Markdown describes the objects; PNG captures their visual arrangement. These exports exclude agent sessions, terminal output and access tokens.

Select objects and choose **Ask an agent**, or clear selection and choose **Ask an agent about this board** to include the whole board. Enter a task and review the context before sending. Eligible connected managed agents receive the text brief and a raster snapshot; running agent terminals receive text and image descriptions. Replies and work appear in the agent's session beside the board. A failed send or image export reports an error and retains the board.

Terminal delivery uses `POST /api/consoles/:id/idea`. The daemon rejects plain shell targets and stopped consoles, sanitizes control characters and embedded bracketed-paste markers, and submits the brief as one bracketed paste. An already-running daemon needs the updated route on its next normal restart. Do not interrupt live agents to enable it.

File exchange is the implemented human collaboration flow. Live remote human invitations, multiplayer cursors, native image generation and agents independently mutating the board are not implemented. There is no cloud service.

## Implementation and validation

This extends the existing console world: the dark dotted backdrop stays in `consoleCanvas.css`; controls reuse `--console-*` tokens and inherited Source Sans 3 typography. Authored paper, ink and shape colors are scoped to planning objects in `planningCanvas.css`, with corresponding export colors in `planningExport.ts`. Terminal, agent and browser tiles and the orchestrator keep their existing roles and controls. Planning documents and history are separate from session reconciliation, so agent exit does not delete authored objects.

The main boundaries are `PlanningLayer.tsx` (interaction and handoff), `planningBoard.ts` (document validation and brief), `usePlanningBoard.ts` (history, storage and recovery), `planningExport.ts` (raster export), and `ConsoleCanvas.tsx` / `ConsoleBoard.tsx` (integration and saved project visibility). Imported files are validated; boards allow at most 500 objects and JSON imports must be smaller than 12 MB.

Run from the repository root:

```powershell
npm run typecheck
npm run build
npm test -- tests/planningBoard.test.ts tests/canvasIdea.test.ts tests/canvasLayout.test.ts tests/canvasTiles.test.ts tests/canvasGroups.test.ts
node scripts/verify-planning-canvas.mjs
```

These are the feature validation commands, not a record of results. The browser verifier expects a running web preview at `http://127.0.0.1:5186` (override with `CANVAS_VERIFY_URL`) and Chrome at its configured Windows path. It mocks API traffic and supplies interaction coverage beyond the focused planning and canvas unit tests.
