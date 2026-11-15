# File workspace and canvas persistence

The file tile is an editing workspace inside the console canvas. It keeps the existing dark dotted canvas, console borders and accent, and adds a scoped dark editor palette. Monaco supplies the editor core used by VS Code, including syntax highlighting, line numbers, editor commands and local language workers. This is an embedded editor; debugger, extension and Git interface parity with VS Code is outside its scope.

## Open, edit and save

Open a project file in a file tile, then use **Explorer** to browse other files under that root. Each selected file opens in a tab in the same tile. Text files are editable, notebooks have a cell editor and a **Source** JSON view, and images and PDFs have previews.

- Use **Save** or **Ctrl+S** to write the active text file or notebook to disk. The equivalent Command shortcut works on keyboards that provide it.
- A dot on the tab and **Unsaved changes** in the footer identify a draft. Switching tabs retains its edits. Drafts are kept in memory and, where browser storage is available, in session storage for recovery after returning or reloading the page. Reopen the file to recover its draft; the entire open-tab list is not persisted.
- **Reload file** reads the disk version. Reloading a dirty file asks before discarding its edits. Closing a dirty tab also asks before discarding.
- If another editor or an agent changes the file on disk, saving refuses to overwrite it and retains the draft. **Download my edits** in the error message exports the draft. Download first if needed, reload the disk version, then reconcile the changes.

Draft recovery is scoped to the browser session and is not a replacement for saving. Browser storage restrictions or quotas can limit recovery; the in-memory draft and unsaved-page warning remain available while the workspace is open.

## Run scripts or use a terminal

**Run file** supports `.py`, `.js`, `.mjs`, `.cjs` and `.ts`. It saves pending edits first and stops if saving fails. The **Output** pane shows stdout, stderr and the exit status; **Stop** ends a running script. Each run is a new process with the project root as its working directory.

Python scripts use `WAYSTATION_PYTHON` when set, otherwise the project root's `.venv` Python when present, otherwise `python` from PATH. JavaScript runs with the daemon's Node executable. TypeScript runs with Node's experimental type stripping, so this is not a full TypeScript build pipeline. Use **Terminal** for a shell at the project root, other file types, package commands or interactive programs. The terminal is an optional console opened on request.

## Execute a notebook

The cell editor supports nbformat 4 notebooks with up to 2,000 cells. Opening a notebook displays its saved outputs and never executes its cells automatically.

1. Choose a registered environment in the **Notebook kernel** dropdown before starting a kernel.
2. Edit a code cell, then select its **Run** button or press **Shift+Enter** while its editor has focus. This runs the current cell. **Run all** runs code cells in document order and stops on an execution error.
3. Use **+ Code**, **+ Markdown**, delete and **Move up** to change the document. Markdown cells switch between **Edit** and **Preview**; double-clicking the preview also opens its editor. To move a cell down, move the following cell up.
4. Inspect text, errors, images/plots and rich table outputs below their code cells. Use **Save** or **Ctrl+S** to persist changed sources, execution counts and outputs with the notebook metadata. **Source** exposes the JSON for direct repair.

A notebook uses a persistent local Jupyter kernel: variables and imports from one cell remain available to later cells. Returning to the notebook in the same browser session reconnects to its existing daemon runtime when it is still available, including a pending cell. Kernel memory is not saved in the `.ipynb` file and does not survive a daemon restart. Idle runtimes expire after 30 minutes without activity.

**Interrupt** requests interruption of the active cell. **Restart kernel** asks before clearing kernel variables; it leaves cell contents and existing notebook outputs intact. The next run starts a fresh kernel, and the dropdown becomes available for selecting another registered kernel. Notebook execution updates the draft; save to keep the resulting outputs on disk.

Rich HTML outputs render in a scriptless, originless sandboxed iframe with a restrictive content policy. Tables can display, but JavaScript-based widgets and interactive HTML applications are not supported. Markdown renders as React elements rather than injected HTML. Notebook input prompts are disabled during execution.

## Local Python setup

The Python interpreter used for the Jupyter bridge needs `jupyter_client` and `ipykernel`. For example, install these in the intended local environment with:

```powershell
python -m pip install jupyter_client ipykernel
```

Install `matplotlib` in the selected kernel environment for plots, and any libraries used by the notebook there. Set `WAYSTATION_PYTHON` before the daemon's next normal start to choose the interpreter that discovers and launches registered kernels. The dropdown lists Jupyter kernels registered with that interpreter; a project `.venv` is automatically preferred for Python script runs, but notebook environments are selected through registered kernels. Python kernels initialize inline plotting without running notebook cells.

The new save and execution routes require the updated backend at the next normal daemon restart. An older running daemon may continue serving the new UI but cannot supply those routes. If it returns file text without a save revision, the workspace explains that saving needs the next normal restart and keeps the draft. Schedule that restart through the usual workflow after current work finishes.

## PDF rendering

PDF.js renders pages inside the tile without a browser PDF plugin. The worker is bundled through Vite's `?worker` import as a normal JavaScript asset, avoiding the previous daemon MIME mismatch for an `.mjs` worker URL. Fonts, character maps and decoder assets are local under `/pdf-assets/` in development and production builds.

Each document owns its worker and closes it when the view unmounts. A document or page failure appears in that PDF's view instead of poisoning a shared worker for later documents. Pages render as they approach the visible area. The preview shows at most the first 300 pages; use a dedicated PDF reader for larger documents.

## Keep the canvas arrangement

Tile positions, sizes, stacking order and each project's pan and zoom are retained when leaving and returning to the canvas or reloading the page. Geometry and viewports are saved in browser local storage; tile content is managed by the daemon. This preserves the arrangement in the same browser profile and origin.

The canvas waits for the agent/console inventory and daemon tile inventory before pruning missing items. A temporary empty list during loading cannot erase saved positions. Layout saves are normally debounced, with an immediate flush on canvas unmount and page hide. Migration updates save metadata without tidying or changing the viewport. Reopening the canvas does not automatically arrange tiles or zoom to fit; **Tidy** and **Fit entire canvas** remain explicit actions.

A new focus/reveal request can still bring a tile into view. Each request is consumed once, with its handled identifier remembered in session storage, so a previously handled request does not replay when returning to the canvas.

## Bounds

| Resource | Current bound |
| --- | --- |
| Editable text file | 2 MiB |
| Notebook file | 25 MiB; cell editor limited to 2,000 cells |
| PDF file | 40 MiB; first 300 pages previewed |
| Concurrent file runtimes | 8 |
| Notebook code submitted per cell | 200,000 characters |
| Cell execution | 120 seconds, then interruption |
| Notebook output | Approximately 5 MB of encoded output per cell; further output omitted |
| Script output | Approximately 1 MB across stdout/stderr, with each chunk limited to 50,000 characters |

Execution is local and uses the selected environment's installed packages. Saved notebook metadata and outputs are preserved, but kernel memory, the open-tab list and script output history are not durable workspace state.

## Validation

Run from the repository root:

```powershell
npm run typecheck
npm run build
npm test -- tests/fileWorkspace.test.ts tests/folderFiles.test.ts tests/notebook.test.ts tests/canvasLayout.test.ts tests/canvasTiles.test.ts tests/canvasGroups.test.ts tests/canvasMarquee.test.ts
node scripts/verify-file-workspace.mjs
node scripts/verify-canvas-persistence.mjs
```

Run the browser verifiers sequentially. Each starts its own isolated production fixture server on port `47359` by default (`FILE_WORKSPACE_TEST_PORT` can override it), using `web/dist`, a temporary project and separate daemon data. They do not require a Vite server or touch real sessions. They require the built UI, local Python/Jupyter, `matplotlib` for the plot fixture, and Chrome at the configured executable path, currently `C:/Program Files/Google/Chrome/Application/chrome.exe`.

The workspace verifier exercises real kernel state shared across cells, Shift+Enter, plots, sandboxed rich output, metadata/output saving, Monaco editing and Ctrl+S, Python script execution, external-change conflict preservation, production PDF worker MIME/rendering, a broken PDF and a narrow viewport. It writes screenshots under `.impeccable/review/`. The canvas verifier checks delayed inventories, legacy layout migration, immediate navigation, reload and consumed reveal requests while asserting positions, sizes, order, pan and low zoom.

These are reproducible validation commands and script assertions; this document does not independently record a successful run.

## Implementation evidence

This scoped extension follows the local product context in [`PRODUCT.md`](../PRODUCT.md), including local operation and honest control affordances. It records the implemented workspace rather than establishing a new global visual identity.

- Workspace, drafts, tabs, conflict recovery and shortcuts: [`FileWorkspace.tsx`](../web/src/components/consoles/FileWorkspace.tsx), [`CodeEditor.tsx`](../web/src/components/consoles/CodeEditor.tsx), [`filesApi.ts`](../web/src/components/consoles/filesApi.ts) and [`fileWorkspace.css`](../web/src/components/consoles/fileWorkspace.css).
- Notebook controls and rendering: [`NotebookEditor.tsx`](../web/src/components/consoles/NotebookEditor.tsx) and [`NotebookView.tsx`](../web/src/components/consoles/NotebookView.tsx).
- Writes, runtime lifecycle and local kernel bridge: [`fileEditing.ts`](../daemon/files/fileEditing.ts), [`workspaceRuntime.ts`](../daemon/files/workspaceRuntime.ts), [`kernel_bridge.py`](../daemon/files/kernel_bridge.py), [`folderFiles.ts`](../daemon/files/folderFiles.ts) and [`files.ts`](../daemon/api/routes/files.ts).
- PDF resource ownership and build assets: [`PdfView.tsx`](../web/src/components/consoles/PdfView.tsx) and [`vite.config.ts`](../vite.config.ts).
- Layout, inventory readiness and consumed requests: [`ConsoleCanvas.tsx`](../web/src/components/consoles/ConsoleCanvas.tsx), [`useCanvasTiles.ts`](../web/src/components/consoles/useCanvasTiles.ts), [`canvasReveals.ts`](../web/src/components/consoles/canvasReveals.ts) and [`canvasLayout.ts`](../web/src/components/consoles/canvasLayout.ts).
- Browser evidence definitions: [`verify-file-workspace.mjs`](../scripts/verify-file-workspace.mjs), [`verify-canvas-persistence.mjs`](../scripts/verify-canvas-persistence.mjs) and [`file-workspace-fixture.ts`](../scripts/file-workspace-fixture.ts).
