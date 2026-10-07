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

Each working folder has its own office. Switch between **folder tabs** above the floor to see only that folder's agents and crew; the selected folder's full path appears below the tabs. Folders with the same name are distinguished by their parent paths. Team members share a table in their team's repository office, including members working in separate worktrees. Sessions without a known folder appear in **Unassigned**.

Agents launched through Waystation keep their name and controls when the background scanner discovers their session transcript. The managed session and its transcript observation share one dashboard entry. Genuine subagents and independent sessions remain separate.

Choose **Moonbase**, **Greenhouse**, or **Deep Sea** to change the environment. Your theme preference is saved in your browser. Use the office crew selector to view a team within the selected office, the deck arrows to see larger crews, and the camera button to zoom or fit the floor. Click a character or a crew row to open the existing agent controls. Folder tabs also work in the full-screen station; use the arrow keys to switch tabs.

**Explore the demo** shows a clearly labeled sample crew without launching agents or enabling live actions. The pause button stops scene animations, and the scene also follows your system's reduced-motion setting.

Spawned Claude Code and Codex subagents are linked to their parent sessions. Dashed arrows on the floor connect parents to their subagents, and parent desks show a subagent count. Selecting a parent or child highlights the link. The crew list groups helpers beneath their parent and labels who spawned them. Open a session's Overview to navigate to its parent or any of its spawned subagents, including helpers beyond the floor's three-character preview. The agent cards preserve multiple generations of nesting.

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

## Cost, guard rails, templates and schedules

**On every agent card:**
- the model it runs;
- an estimated cost;
- how full its context window is.

A red strip appears when an agent's last turn failed, or when the runaway guard stepped in.

**Spend.** Costs are estimates at Anthropic list price, from the token counts in each session's transcript.
- Codex agents show tokens only. There is no list price we can rely on for them.
- If you use a subscription plan, you are billed differently.
- **Usage & schedules** in the sidebar shows today, the last 7 days, and the agents that spent the most.

**Runaway guard.** It watches every agent for:
- the same tool call repeated 6 times in a row;
- 6 errors within 3 minutes;
- optionally, spending past a per-agent limit.

It steps in one level at a time:
1. It sends the agent a message telling it to stop and rethink.
2. Next time, it turns on tool approvals (Claude), or interrupts the turn (Codex).
3. It only stops an agent if you allow it to.

**Clear guard** in the agent's details resets it. Configure the guard with environment variables before `npm start`:
- `AGENT_TOWER_AGENT_BUDGET_USD=5`: per-agent spend limit.
- `AGENT_TOWER_BREAKER_HARD_STOP=1`: allow the last level, stopping the agent.

**Rename** any agent from its details. The name is kept across tower restarts.

**Restart & continue** (agents launched here):
- It stops the agent and starts it again on the same conversation, optionally on a different model.
- It is not available for team members (pause and resume the team instead) or for agents open in your terminal.

**Questions.** When a managed Claude agent asks you something (Claude Code's `AskUserQuestion`), the question appears with the approvals. Pick an option or type an answer.

**Templates.** In **New agent**, **Save as template** keeps the agent type, model, name, role instructions and first task. Picking a template later only fills in the form; you still press Launch.

**Schedules** launch an agent at a set time on chosen weekdays (**Usage & schedules → New schedule**).
- A run missed by more than 10 minutes, because the tower was off or the PC asleep, is skipped rather than fired late.
- **Run now** launches one immediately.

**Prerequisites.** That page also checks Node, Git, Claude Code, Codex, Windows Terminal and the hooks. It only reports; it never installs anything.

## Working in the real Claude Code or Codex CLI

Every Claude Code and Codex session can be opened in the real CLI, in a Windows Terminal tab, so you use it exactly like your own session, with `/usage`, `/model`, `/compact` and the rest.

- **Open in Claude Code / Codex** (agent details, for sessions running outside Waystation, such as your own Claude Code sessions or Codex threads in your editor): opens a copy of the conversation (`claude --resume <id> --fork-session`, or `codex fork <id>`) in the session's folder. The original keeps running where it is; from then on the two are separate. A Claude session with no conversation yet opens as a new session in its folder.
- **Agents launched from Waystation are only ever ended from Waystation.** While one is open in your terminal it keeps its card (marked *In your terminal*). Closing the terminal hands it back: Waystation resumes the same conversation and the agent waits, idle, for instructions. **Stop** in Waystation closes its terminal session and ends it. With hooks installed, messages sent from Waystation reach the terminal session after its next tool call.
- **Continue in Claude Code / Codex** (agent details, for agents launched from Waystation): once the agent is idle, Waystation stops its own copy and opens a Windows Terminal tab running `claude --resume <session>` (or `codex resume <thread>`) in the agent's folder, with the same conversation and model. With hooks installed, Waystation keeps showing it as a Hook-control session.
- **CLI** (team page, per member): the same, for a team member. Its session keeps its `team` tools (channel, board) and its standing instructions, plus a note that you are now driving it.
  - While it is open in your terminal, the team never wakes it or starts a second copy. Messages to it wait.
  - When you exit the CLI or close the tab, the member rejoins the team straight away on that same session (idle, without spending budget, unless mail is waiting). **Take back** does this immediately; the old tab then loses team access.
  - A member in your CLI uses your normal Claude Code permission prompts instead of the team's file guard rail, so check what it writes.
- **Open in Claude Code** (team page header): a Claude Code session for you, as the operator, opened in the project. It has team tools for you (`team_status`, `read_channel`, `send_message`, `pause_team`, `resume_team`, `member_changes`) but cannot merge or disband: those stay in Waystation. Messages it sends are posted as the operator, and Claude Code asks your permission for each tool call. Its access ends when the session closes.

How it works: the tab runs a small launcher (`daemon/cli/launchCli.ts`). The tower writes a one-time ticket into its private folder (`%LOCALAPPDATA%\agent-tower\cli-tickets`) with the command and folder; the launcher reads and deletes it, checks in with the tower, and only then starts the CLI. If the tower doesn't confirm the session, the CLI is not started, so a session can never run in your terminal and in the team at once.
- Tokens never appear on a command line. Claude Code reads its team token from a private MCP config file next to the ticket (passed with `--mcp-config <file>`); Codex receives it in its environment. Both files are deleted when the session ends.
- The tower watches both the launcher and the CLI process. The session ends when you exit the CLI or close the tab, not if only the launcher dies.
- Set `AGENT_TOWER_CLAUDE_EXE` if `claude.exe` is not in the npm global folder or on `PATH`.

Limits:
- A member that was in your CLI when the tower restarted rejoins the team when you resume it; close its old tab first. Its team access ended with the restart.
- **Take back** asks you to close the member's tab first: if that session keeps running, two copies of the member would work on the same conversation.
- A member open in your CLI can't be merged until it is back with the team.
- The first time Claude Code runs in a folder from a terminal, it asks whether you trust that folder. That prompt is Claude Code's own.

## Text console (optional)

A lightweight, text-only console can follow an agent or team from any terminal without opening the CLI. It is not Claude Code: slash commands such as `/usage` don't exist there. Start it from this folder:

```bash
npm run attach                          # list what you can attach to
npm run attach -- agent <id or name>    # one agent
npm run attach -- team <id or name>     # one team (add --all to include member tool activity)
```

The console shows recent history, then streams live activity. It is a view onto the tower, not a second copy of the agent: closing it (`/quit` or Ctrl+C) leaves everything running.

- **Agent console:** type a message to send it. `/interrupt`, `/stop`, `/intercept on|off`, and `/approve`, `/deny [reason]` or `/ask` for a held tool call.
- **Team console:** plain text goes to everyone, `@name …` to one member. `/tasks`, `/members`, `/pause`, `/resume`, `/diff <member> [full]`, `/merge <member>`, `/attach <member>` (opens that member's own console), and `/filter channel|everything`.

`/help` lists the commands. Stopping and merging ask for confirmation, as they do in the UI. The console reads the access token from `daemon.json`, the same way `npm run open` does, so the token never appears on a command line. If Windows Terminal can't be started, the error shows the `npm run attach` command to run instead.

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
  usage/        token and cost accounting (list prices, transcript parsing)
  guard/        runaway guard policy (loops, error storms, budget)
  ops/          rename, restart & continue, templates, schedules, prerequisites
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
npm test             # 273 tests
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
