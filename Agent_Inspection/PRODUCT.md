# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Developers who run several AI coding agents (Claude Code, Codex, Aider, Gemini CLI, Cursor Agent, OpenCode, Goose) at once on their own Windows machine, in terminals, VS Code, or launched from Waystation. Teams and other developers are the intended audience. They glance at the station while doing other work and come back to it when an agent needs them.

## Product Purpose
Waystation ("Agent Tower") lets a developer see and steer every coding agent on their machine from one local place. Success is knowing at a glance who is working, who is waiting, and who needs a decision, and being able to act on it (approve, edit, deny, instruct, stop, delegate) without hunting through terminals.

## Positioning
One view across vendors, with real intervention: it can hold an agent's next tool call for approval, run mixed Claude + Codex teams that share a task board in separate git worktrees, and guard against runaway loops and spend. The live agents are shown as an animated illustrated crew in an office per project folder, which a plain dashboard does not do.

## Operating Context
Runs locally on Windows, Node 22+, served on localhost with a per-start access token. Agents appear whether they run in a terminal, VS Code, or Waystation itself. Control level varies per agent and is shown as a badge: Full control, Hook control, Observe only. Waystation opens real Claude Code / Codex sessions in Windows Terminal tabs on handoff.

## Capabilities and Constraints
- Intercept tool calls: Approve, Edit input, Deny + instruct, Let agent ask.
- Send messages, interrupt/stop agents, delegate work, attach skills.
- Teams: shared task board, inter-agent messaging, git worktree sandboxes, merge on demand.
- Cost estimates, context fill, runaway guard, templates and schedules.
- Local only: no cloud, accounts, or remote access. Windows only.
- Demo mode ("Explore the demo") shows a clearly labeled sample crew with no live actions.
- Characters (Pip, Mica, Orbit, Sprout, Bolt, Nova) are original vector art; their identities stay consistent per session.
- The scene is a visualization; character movement never issues agent commands.

## Brand Commitments
The animated station scene and its crew are core identity and must be kept. Environments (Moonbase, Greenhouse, Deep Sea) are part of the product. Locally hosted Source Sans 3 with Georgia headings is the current type setup (OFL license shipped in the repo).

## Evidence on Hand
Screenshot at `docs/waystation.png`; README with feature and control-level tables. No testimonials, customers, benchmarks, or pricing exist; do not invent any.

## Product Principles
1. Approvals are the highest-stakes, time-sensitive action; approving or denying a held tool call must always be fast and prominent, in the scene as well as in lists.
2. Status first: working, waiting, idle, and stopped must be readable at a glance without opening anything.
3. Be honest about control: never show a control the tower cannot deliver for that agent; say where to act instead.
4. The scene delights but never gets in the way of operating; anything animated has a calm fallback.
5. Local and trustworthy: secrets, tokens, and tool payloads are handled carefully and shown only on demand.

## Accessibility & Inclusion
Respect the system reduced-motion setting and offer a pause for scene animation. Keep keyboard navigation working (e.g. arrow keys between folder tabs in the full-screen station).
