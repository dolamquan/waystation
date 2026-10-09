# Waystation desktop

Waystation runs locally on Windows in an Electron window, backed by a separate Node.js daemon. This release is distributed as source: clone the repository and launch it with npm. Agent providers use your own accounts and network connections.

## Install and launch

Install Git and Node.js **22.20 or newer**. Keep npm development dependencies enabled: they include Electron and the UI build tools.

```powershell
git clone <your-repository-url> Waystation
cd Waystation\Agent_Inspection
npm ci
npm run desktop
```

Replace `<your-repository-url>` with your actual GitHub clone URL. If the application folder itself is your repository root, omit `\Agent_Inspection`. Installation downloads Electron; the first launch builds the interface if needed. No installer, Rust toolchain, or C++ build tools are required for this workflow.

**Desktop setup** checks local tools on first launch. Missing optional tools do not block the station. You can explore immediately; Waystation does not install providers or log in on your behalf.

| Tool | Used for |
| --- | --- |
| Node.js 22.20+ | Running Waystation and its build tools; required |
| Git | Cloning Waystation and creating team worktrees |
| Claude Code / Anthropic authentication | Claude agents and CLI handoffs; the Agent SDK is included |
| Codex CLI / OpenAI authentication | Managed Codex agents and team members |
| Windows Terminal | Opening real agent CLIs and text consoles |
| Claude Code hooks | Reviewing tools and messaging existing Claude sessions |

Run `claude` or `codex` in your terminal and follow your provider's sign-in instructions. Configure your own API access if that is how you normally authenticate. Setup checks report installation, not account status or remaining credits. **Install hooks** backs up Claude settings and preserves other hooks; new sessions pick them up, and older sessions may need restarting.

## Window, tray, and quitting

- Closing the window hides it to the tray. Agents and schedules continue while the computer is awake.
- Double-click the tray icon or choose **Open Waystation** to return. Its tooltip shows working agents, attention, and approvals.
- **Needs attention** opens waiting agents, held tool decisions, and guard reviews. Toggle notifications in the tray or Desktop setup. Windows notification settings still apply.
- Native folder pickers are available in new-agent, new-team, and schedule forms.
- Window size, position, maximized state, setup completion, and preferences survive restarts.
- **Quit Waystation** stops its desktop-owned daemon, releases held approvals to the normal permission prompt, and stops managed agents. It asks before ending active managed work. Reopen Waystation for schedules; use the usual resume actions for agents and teams.
- A daemon started separately with `npm start` or `npm run daemon` remains under that terminal's control. The desktop authenticates and reuses it; quitting the desktop leaves it running. Stop it in its original terminal.
- Keep the launcher terminal open while using this source release. Closing it ends the desktop; no Windows service or login startup is installed.

**Ctrl+,** opens Desktop setup and **Ctrl+Q** quits. Standard editing and zoom shortcuts are available in the application menu.

## Configuration and data

Use **Desktop setup → Custom session and executable paths** for installations outside the usual locations. Saved path overrides take precedence over environment variables. Clear a field to use environment settings or automatic detection.

| Environment variable | Meaning |
| --- | --- |
| `AGENT_TOWER_HOME` | Data directory; default `%LOCALAPPDATA%\agent-tower` |
| `AGENT_TOWER_PORT` | Local daemon port; default `4317` |
| `CLAUDE_HOME` | Claude configuration/session folder; default your user `.claude` folder |
| `CODEX_HOME` | Codex session folder; default your user `.codex` folder |
| `AGENT_TOWER_CLAUDE_EXE` | Native Claude `.exe` path |
| `AGENT_TOWER_CODEX_JS` | npm Codex entry, usually `@openai\codex\bin\codex.js` |

Set environment variables before launching, for example:

```powershell
$env:AGENT_TOWER_PORT = '4318'
npm run desktop
```

Changing saved paths restarts the desktop-owned daemon; stop managed agents and resolve approvals first. Stop a terminal-owned daemon before reopening the desktop to configure its paths.

Data stays outside the checkout. `tower.db` stores application state, `desktop.json` stores preferences, and `desktop-profile` stores the window's browser profile. `daemon.json` contains the per-start token; `daemon.lock` prevents duplicate startup. Integration secrets live in `secrets.json`. Desktop preferences contain no credentials, and the desktop launcher keeps tokens off process command lines and out of its console output.

Back up the data directory while Waystation is stopped. Updating or re-cloning source does not remove it. Do not share it or put it in Git. Existing `%LOCALAPPDATA%\agent-tower` data is reused without a folder rename or account migration.

## Update

Quit Waystation, then run from the application folder:

```powershell
git pull --ff-only
npm ci
npm run desktop
```

Commit or set aside your source edits before pulling, and review changes before running a new revision. Changed UI inputs are rebuilt automatically. Updates use Git; automatic app updates are not configured.

## Troubleshooting

| Symptom | Recovery |
| --- | --- |
| Electron missing or download fails | Run `npm ci` with internet access and development dependencies enabled. Check proxy/antivirus restrictions on Electron's download. |
| Node version error | Install Node 22.20+ and reopen your terminal. Check `node --version`. |
| Port already in use | Quit other Waystation instances or choose an unused `AGENT_TOWER_PORT`. An unrelated HTTP server is never accepted as Waystation. |
| Running daemon cannot be authenticated | Stop it in its terminal and launch again. Older revisions need restarting. |
| Window or daemon fails | Use **Try again**. Window recovery preserves the existing daemon; daemon recovery starts a fresh authenticated instance. Check the launcher terminal for errors. |
| Unreadable lock | Close Waystation and verify its recorded PID is no longer running before removing that lock. Never remove a live instance's lock/readiness file. Dead-owner locks normally recover automatically. |
| Path changes refused | Stop managed agents, return CLI handoffs, and resolve approvals. For a terminal-owned daemon, stop it and reopen the desktop. |
| Notifications absent | Check Desktop setup and Windows notification/Focus Assist settings. Source launches can have different toast behavior from installed apps; decisions remain in the station. |
| No sessions appear | Confirm the session folders and start a provider session under this Windows user. Installation does not create conversations. |
| Voice input unavailable | This desktop release denies renderer device permissions. Use the message composer or the browser interface for browser-supported voice input. |

## Verification and development

```powershell
npm run typecheck
npm test
npm run build
npm run desktop:verify
npm run desktop:verify -- --fresh
npm run check:publication -- --history
```

Desktop verification launches actual Electron with isolated session/configuration folders and a fake Codex fixture. It checks startup, renderer isolation, setup, native picker wiring, missing tools, custom paths, tray behavior, duplicate launch, approvals/notifications, quit cancellation, shutdown, persistence, crash recovery, and terminal-owned daemon reuse. No paid provider is launched. `--fresh` copies source to a path containing spaces, performs `npm ci`, and starts without a UI build or existing Waystation state. Artifacts remain in the ignored `.desktop-verification` directory.

This simulates another user's folders on the current Windows machine; it does not create another Windows account or VM. Provider authentication, actual OS toast delivery, antivirus policies, and billing require checks in their real environments. The GitHub Windows workflow also runs verification from a clean checkout.

The browser workflow remains available through `npm start`, and web development through `npm run daemon:dev` plus `npm run dev:web`. Desktop code lives in `desktop/`; its launcher passes the regular Node executable to Electron. The daemon keeps its HTTP/WebSocket token, Host/Origin checks, and CSP. The renderer is sandboxed and receives only explicit setup and picker actions through its preload bridge.

## Current scope

Windows is supported. This release has no installer, code signing, automatic updates, Windows service, remote access, or login startup. Sleeping/offline computers do not run schedules. Existing agent-control and team-isolation limits still apply. A project license remains undecided.

Use **Quit Waystation** or Ctrl+C in the launcher terminal for graceful cleanup. Task Manager, a forced process-tree kill, or an OS shutdown can interrupt cleanup and held requests. Locks belonging to dead daemons recover on the next launch.
