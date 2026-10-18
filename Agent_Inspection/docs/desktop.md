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

### Agent-written notifications

Automatic attention alerts cover waiting agents, held approvals, and guard warnings. Agent-written progress and completion messages use Waystation's `notify` tool. New managed launches receive it automatically, including team agents and resumed sessions. On Windows, the default destinations are **Updates (in-app)** and the first enabled **Desktop** channel. Waystation creates a local **Windows desktop** channel if none exists. Paused Desktop channels stay paused, and external destinations such as email or Slack are never selected automatically.

Choose notification channels in the launch form to override those defaults. Selecting only **Updates (in-app)** does not send a Windows banner. Manage delivery channels in **Library → Notifications**; the Desktop setup/tray notification switch controls the separate automatic attention alerts.

Claude Code's built-in `PushNotification` is not Waystation's desktop delivery mechanism and is disabled for Waystation-managed Claude sessions. Waystation notifications do not require Claude to be inactive. Keep Waystation running; closing its window to the tray is fine. After updating the daemon, use **Restart & continue** or start a new agent to attach the tool to a session launched without it.

When the desktop is connected, Desktop channels use Electron's native system notifications under the **Waystation** identity. The source app registers a per-user **Waystation** Start Menu shortcut on startup; it points to this checkout's Electron executable. Clicking a notification opens Waystation. Delivery waits for Windows' acknowledgment; native failures or a disconnected desktop are returned to the agent and recorded with the inbox update. The browser-only daemon retains the PowerShell Windows-toast transport. Acknowledgment means the OS accepted the alert, not that a visible banner was displayed: Do Not Disturb and Windows notification settings still apply. Inbox-only messages do not produce duplicate system alerts.

### Agent awareness and prompt caching

Claude and Codex launches receive the same concise Waystation briefing, including normal launches, team members, scheduled agents, resumed sessions and CLI handoffs. Claude SDK subagents receive it through their startup hook as well. Claude uses the default Claude Code system prompt with the briefing appended; Codex uses `developer_instructions` for both fresh and resumed threads. User messages are not prefixed with another copy on each turn. Role and loadout instructions follow the stable briefing; credentials and destination ids stay outside it. Notification tool descriptions list destination kinds, including Desktop, so the agent can distinguish a Windows alert from inbox-only delivery. Restarting renews the per-agent notification grant while preserving selected destinations.

The [Claude Agent SDK automatically enables prompt caching](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-cache-tokens). Codex manages its own requests and caching; Waystation does not add unsupported raw API cache parameters to the CLI. Keeping instructions and tool definitions stable helps eligible prefixes reuse the [OpenAI prompt cache](https://developers.openai.com/api/docs/guides/prompt-caching). Existing usage metering records providers' cache-read and cache-write token counts.

Caching reduces repeated processing and may reduce cost and latency; it does **not** remove instructions from the context window, make new agents remember them without receiving them, or guarantee every new launch hits a cache. Hits depend on model, matching prompt/tool prefixes, provider/account support and cache expiration. Waystation does not pad the briefing or make paid prewarming requests. New Claude sessions snapshot their system prompt to preserve its rendered prefix. Resumed sessions refresh it so older conversations load current application instructions; their appended briefing remains stable. New sessions are the most reliable way to replace outdated assumptions in conversation history. Sessions merely discovered outside Waystation are not reconfigured by observation.

### Send to an existing VS Code terminal

Install the companion once with `npm run vscode:install` from the application folder. It packages and installs a local extension; it does not publish to the Marketplace. Restart Waystation to load the new daemon, leaving your original Claude terminal running. In VS Code, run **Waystation: Connect terminal sessions** from the Command Palette. Waystation's chat shows **VS Code terminal connected** when the matching session is ready.

Idle standalone Claude sessions in local Windows VS Code terminals can now receive a message immediately. It is pasted and submitted to the original terminal, preserving the process and conversation. Keep that terminal's input empty, and finish any local permission prompt or menu first. Busy sessions continue receiving instructions through installed hooks. Previously queued instructions are consumed when the next prompt triggers those hooks.

The extension checks the live session, process start time and terminal ancestry before sending. A submission acknowledgment confirms VS Code accepted the input, not that Claude completed a turn. An uncertain delivery is never automatically retried. The public terminal API cannot inspect Claude's input draft or atomically pin a foreground process; avoid typing, exiting Claude, or changing its foreground program during a submission. Remote/WSL/container terminals, editor-hosted Claude sessions and terminals outside VS Code are not supported. See the [companion setup guide](../integrations/vscode/README.md) for custom paths, terminal persistence, disabling the bridge and troubleshooting.

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
npm run desktop:notify:verify
npm run check:publication -- --history
```

Desktop verification launches actual Electron with isolated session/configuration folders and a fake Codex fixture. It checks startup, renderer isolation, setup, native picker wiring, missing tools, custom paths, tray behavior, duplicate launch, approvals/notifications, quit cancellation, shutdown, persistence, crash recovery, and terminal-owned daemon reuse. No paid provider is launched. `--fresh` copies source to a path containing spaces, performs `npm ci`, and starts without a UI build or existing Waystation state. Artifacts remain in the ignored `.desktop-verification` directory.

This simulates another user's folders on the current Windows machine; it does not create another Windows account or VM. Provider authentication, antivirus policies, and billing require checks in their real environments. The GitHub Windows workflow also runs verification from a clean checkout. The separate `desktop:notify:verify` command sends one actual native system alert without starting a daemon or coding agent. It registers the source shortcut, waits for the OS's acknowledgment and exits; banner visibility still follows Windows settings.

The browser workflow remains available through `npm start`, and web development through `npm run daemon:dev` plus `npm run dev:web`. Desktop code lives in `desktop/`; its launcher passes the regular Node executable to Electron. The daemon keeps its HTTP/WebSocket token, Host/Origin checks, and CSP. The renderer is sandboxed and receives only explicit setup and picker actions through its preload bridge.

## Current scope

Windows is supported. This release has no installer, code signing, automatic updates, Windows service, remote access, or login startup. Sleeping/offline computers do not run schedules. Existing agent-control and team-isolation limits still apply. A project license remains undecided.

Use **Quit Waystation** or Ctrl+C in the launcher terminal for graceful cleanup. Task Manager, a forced process-tree kill, or an OS shutdown can interrupt cleanup and held requests. Locks belonging to dead daemons recover on the next launch.
