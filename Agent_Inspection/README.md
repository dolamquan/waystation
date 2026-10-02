# Agent Control Tower

One place to see every coding agent running on this machine, and to step in when you need to: intercept a tool call, give an instruction, stop an agent, hand its work to a new agent, or attach a skill.

Runs locally on Windows. Node 22+.

## Quick start

```bash
npm install
npm start          # builds the UI and starts the daemon on http://127.0.0.1:4317
npm run open       # opens the UI with this run's access token
```

The daemon prints a link like `http://127.0.0.1:4317/#token=…`. The token changes every time the daemon starts. Press the power button to bring the tower online.

To have the tower intercept and instruct the Claude Code sessions you already run, click **Install hooks** in the top bar (see [Hooks](#hooks)).

## Waystation: your animated agent workspace

Click **Enter the station** to see live sessions as a crew of original vector characters: Pip, Mica, Orbit, Sprout, Bolt, and Nova. Character identities stay consistent for each session. Working characters type, waiting characters wave for attention, idle characters stroll, and stopped characters sleep. The scene is a visualization; character movement does not issue agent commands.

Choose **Moonbase**, **Greenhouse**, or **Deep Sea** to change the environment. Your theme preference is saved in your browser. Use the project selector to view a team, the deck arrows to see larger crews, and the camera button to zoom or fit the floor. Click a character or a crew row to open the existing agent controls.

**Explore the demo** shows a clearly labeled sample crew without launching agents or enabling live actions. The pause button stops scene animations, and the scene also follows your system's reduced-motion setting.

Select a session to open **Overview**, **Activity**, or **Details**. Overview shows its current state and available actions. Activity starts with conversation messages; use **Tool calls** or **Everything** to inspect recorded tools and session updates. Tool payloads and technical session identifiers are expandable, and recorded activity is searchable. Observed sessions explain where to send messages rather than showing unavailable controls.

The interface uses a locally hosted [Source Sans 3](https://github.com/adobe-fonts/source-sans) font with Georgia headings. Its OFL license is included in `web/public/fonts/SourceSans3-LICENSE.md`.

## What you can do with each agent

Every card carries a badge saying how much control the tower has:

| Badge | Which agents | See live | Intercept / instruct | Stop | Delegate / skills |
|---|---|---|---|---|---|
| **Full control** | Agents launched from **+ New agent** (Claude Agent SDK, or `codex exec`) | ✅ | Claude: approve, deny or edit each tool call, send messages, interrupt. Codex: send follow-ups between turns. | ✅ | ✅ |
| **Hook control** | Your existing Claude Code sessions (terminal or VS Code) | ✅ | ✅ once hooks are installed | ✅ (stops the `claude.exe` process and its children) | ✅ |
| **Observe only** | Codex threads in your editor, Aider, Gemini CLI, Cursor Agent, OpenCode, Goose | ✅ | ❌ | Standalone CLIs only | Delegate hands off to a new Claude agent |

How the actions work:

- **Intercept:** the agent's next tool call is held until you choose **Approve**, **Edit input**, **Deny + instruct**, or **Let agent ask** (which falls back to Claude Code's own permission prompt).
- **Instruct:**
  - Managed agents receive the message immediately.
  - Hooked Claude Code sessions receive it after their next tool call, or when they try to stop.
  - If a session is idle at its prompt, the instruction arrives with the next prompt you type in that session.
- **Delegate:**
  - From a Claude session, starts a managed agent that forks the session's full context and works on a new task.
  - From any other agent, starts a managed agent with a summary of that agent's recent activity.
  - Optionally stops the original agent.
- **Skills:** copies a skill from `~/.claude/skills` or an installed plugin into the project's `.claude/skills`, then tells the agent about it (when it accepts instructions).

Editor-hosted Codex threads can't be stopped from the tower. They share one app-server process with your editor, and stopping it would end every Codex thread there.

## Agent teams

Open **Teams** in the sidebar and click **New team** to put several agents on one goal. Teams can mix models: for example a Claude lead, a Codex builder and a Claude reviewer on Haiku. Each member can have its own model.

How a team works:

- **Sandboxes.** Each member gets its own git worktree and branch (`team/<name>-<id>/<member>`), stored in `%LOCALAPPDATA%gent-tower	eams`, so members never overwrite each other or your checkout.
  - Codex members run with the `workspace-write` sandbox.
  - Claude members cannot use Write/Edit outside their worktree, or on agent and git configuration inside it. Shell commands aren't covered, so treat this as a guard rail, not a security boundary.
- **Shared channel and task board.** Every member, whatever its model, gets the same `team` MCP tools: `team_roster`, `post_message`, `read_messages`, `list_tasks`, `create_task`, `claim_task`, `update_task`, `handoff`, and `finish_team` (lead only).
  - The tools are served by a small stdio bridge (`daemon/teams/team-mcp.mjs`) that both Claude and Codex launch.
  - Each member has its own token, so an agent can only act as itself, and it never sees the operator token.
- **Lead and workers.**
  - The lead receives the goal, splits it into tasks and assigns them.
  - Workers start only when they get their first task or message.
  - Finishing or blocking a task notifies the lead.
  - The lead calls `finish_team` once every task is done.
- **Wake-ups.** When a member has unread messages and is idle, the tower starts its next turn with those messages. This is how a Codex agent and a Claude agent hold a conversation.
- **Guard rails.**
  - Each team has a wake-up budget (one wake-up = one agent turn) and a time limit.
  - If everyone goes idle with work left, the lead is prompted once. If nothing changes after that, the team pauses.
  - A paused team never loops. **Resume** adds budget and time.
  - Intercept still works on Claude members.
- **Shared log.** The team page shows the channel, task changes, merges and (under **Everything**) each member's tool activity. Agents see the channel and the board, not each other's raw transcripts.
- **You merge.** **Diff** shows a member's changes since the team started. **Merge** commits the worktree and merges its branch into the base branch, but only if your checkout is on that branch with no uncommitted changes. On a conflict, nothing is changed.
- **Disband** stops all members and removes their worktrees. Unmerged branches are kept.

The project folder must be the top of its own git repository; a subfolder of a larger repo is refused. If the folder isn't a repo yet, tick **Set up git**. Worktrees contain only committed files.

Teams survive a tower restart. They come back as **Stopped**, and **Resume** relaunches their members.

## Hooks

**Install hooks** adds one small script (`claude-hook.mjs`, copied to `%LOCALAPPDATA%\agent-tower\hooks`) to `~/.claude/settings.json`. It is registered for these events:

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`
- `SessionStart`
- `SessionEnd`

Your settings are backed up to `%LOCALAPPDATA%\agent-tower\backups` first. **Remove hooks** deletes only the tower's entries.

Sessions started after you install pick up the hooks. Sessions that were already running may need a restart.

Safety rules:
- **Intercept off:** the hook never blocks anything. If the tower isn't running, Claude Code behaves exactly as before.
- **Intercept on:** if no decision arrives in time, or the tower is unreachable or returns an error, the hook answers **ask**, so Claude Code shows its normal permission prompt. A held call is never silently allowed.
- Stopping the tower normally turns off every Intercept. Intercept flags and queued instructions for a session are also cleared when that session ends.

## Security model

- The daemon listens on `127.0.0.1` only.
- The API and WebSocket require the per-run token, which is stored in your user-only `%LOCALAPPDATA%\agent-tower\daemon.json`.
  - The UI receives it in the URL fragment, which never reaches the server or its logs.
  - The WebSocket carries it as a subprotocol, not in a query string.
- `Host` and `Origin` are checked on every request, which blocks DNS rebinding and cross-site requests. The UI is served with a strict CSP and `frame-ancestors 'none'`.
- These actions require explicit confirmation and are written to an audit log (`GET /api/audit`):
  - stopping an agent
  - attaching a skill
  - installing hooks
  - instructions and approval decisions
- Stop only targets processes the tower discovered. Before stopping, it re-checks the process name and start time (to guard against a reused PID), and it never targets VS Code, terminals or shells.
- Event history is clipped, scrubbed of common secret formats, and kept for 7 days.

## Where things live

```
daemon/
  collectors/   Claude session registry + transcripts, Codex rollouts, process scan
  hooks/        claude-hook.mjs (runs inside Claude Code), installer, intercept/inbox flags
  managed/      Claude Agent SDK runner, codex exec runner, write guard
  teams/        team manager, board + MCP tools, git worktree sandboxes, stdio MCP bridge
  actions/      stop (taskkill guard), skills
  api/          HTTP + WebSocket server, request security
  tower.ts      service layer: every action goes through here and is audited
web/src/        React + Framer Motion UI
tests/          Vitest unit and integration tests (real hook script against a real server)
```

Runtime state (database, token, flags, backups) lives in `%LOCALAPPDATA%\agent-tower`, outside OneDrive. Set `AGENT_TOWER_HOME`, `CLAUDE_HOME` or `CODEX_HOME` to point elsewhere.

## Development

```bash
npm run daemon:dev   # daemon that also trusts the Vite dev server origin
npm run dev:web      # Vite on http://127.0.0.1:5173 (proxies /api and /ws)
npm run open         # opens the dev UI when the daemon runs with --dev
npm test             # 187 tests
npm run test:coverage
npm run typecheck
```

## Known limits

- Managed Claude agents load your user settings, so your plugins, MCP servers and global hooks apply to them as they do to Claude Code. This keeps their behaviour familiar, but makes each turn slower and more expensive.
- **Team sandboxes stop accidents, not a hostile agent.** Members run as your Windows user. A member with a shell could read `%LOCALAPPDATA%\agent-tower\daemon.json`, which holds the tower's access token, and use it to approve its own tool calls or merge branches.
  - Claude members' file tools (Read/Grep/Glob) are blocked from that folder. Shell commands are not.
  - Real isolation needs a separate OS user or a container. That's the planned next phase. Until then, treat Intercept on a team member as a convenience, not a security boundary.
- What the tower does against a misbehaving member:
  - Member tokens are kept out of command lines.
  - Teammates' messages are quoted, so a teammate can't impersonate the operator.
  - Planted git hooks and fsmonitor settings are ignored when the tower runs git.
  - Branches that change `.claude/`, `.codex/`, `.mcp.json`, git hooks or attributes, or `CLAUDE.md`/`AGENTS.md` are never merged automatically.
- Team members load your user settings too, including global hooks. A hook that blocks tool calls slows every member down.
- A member can't be merged while it's mid-turn. Pause the team, or wait for that member to go idle.
- Team members can't run each other's code together until you merge, because each works in a separate folder.
- Codex members can't commit inside their sandbox. The tower commits their worktree when you merge.
- Codex threads are matched to running Codex processes heuristically and shown as "likely live" for up to an hour after their last write.
- Detection of other CLIs (Aider, Gemini CLI and so on) is by process name and command line, so it isn't exhaustive.
