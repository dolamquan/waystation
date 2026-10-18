# Waystation Terminal Bridge

This local companion lets Waystation submit messages to Claude Code **in its original VS Code integrated terminal**, including while idle. The Claude process and conversation stay where they were started.

## Setup

From the Waystation application folder, after `npm ci`:

```powershell
npm run vscode:install
```

Start Waystation, then in the existing VS Code window open the Command Palette and run **Waystation: Connect terminal sessions**. The status bar reports the number of connected Claude terminals. In Waystation, their chat shows **VS Code terminal connected**. If Waystation was already running when its source changed, quit and reopen it to load the new daemon. A separately started daemon must be restarted in its own terminal.

The installer builds a VSIX with the existing `ws` dependency and installs it locally. It does not publish an extension or restart VS Code. If your editor requests a window reload, check terminal persistence first: enable `terminal.integrated.enablePersistentSessions` before choosing **Developer: Reload Window**. Process reconnection normally preserves terminals during reload; closing the window and reopening it can instead relaunch their shell. Do not close the Claude terminal. For a nonstandard editor installation, set `WAYSTATION_VSCODE_EXE` to `Code.exe`, or install the generated `.vsix` through **Extensions → Install from VSIX**.

## How messaging works

- Local Windows VS Code terminals running a standalone interactive `claude` CLI are discovered by matching the session's process identity and ancestry to a terminal's shell process. Matching uses no terminal titles or currently focused window.
- Idle sessions receive a literal paste followed by Enter. Multiline messages use bracketed paste. Keep Claude's terminal input **empty**, and finish local permission prompts or menus first. The public terminal API cannot read or replace a Claude input draft; simultaneous typing can merge with the submitted message.
- Busy sessions keep using Waystation's existing hooks. Install those hooks to deliver instructions at a tool boundary or Stop. An already queued message is consumed when the next submitted prompt runs the hook.
- The extension verifies current metadata, process start time, ancestry and idle status again before submitting. It does not stop, fork, resume, interrupt or switch focus to the process.
- “Submitted” means VS Code accepted the input calls. The API does not acknowledge a Claude model turn. After an uncertain acknowledgment or timeout, check the original terminal before resending; Waystation does not retry automatically.

The bridge uses the existing authenticated loopback daemon connection. Tokens, prompts, and process command lines are not written to the extension output channel. No model requests are made by discovery. Disable it with the user setting `waystation.terminalBridge.enabled`. For custom application state, set `waystation.terminalBridge.dataDirectory`; the Claude session path is provided by the connected daemon.

## Current limits

Local Windows terminals only. Remote SSH, WSL, containers, terminal multiplexers, editor-hosted Claude extension sessions, background sessions, Codex, and terminals outside VS Code are not supported by this bridge. More than one Claude process under a terminal is refused. Busy sessions without installed hooks still require terminal input. Extension workspace trust is required.

VS Code's API types input into an existing terminal and cannot atomically pin its foreground process. Identity checks reduce stale routing, but closing Claude or changing the foreground program concurrently with sending can race with delivery. Avoid those actions while a submission is in progress.
