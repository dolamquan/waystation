# Product

<!-- impeccable:product-schema 1 -->

## Platform

web and Windows desktop (Electron)

## Users
Developers who run several AI coding agents (Claude Code, Codex, Aider, Gemini CLI, Cursor Agent, OpenCode, Goose) at once on their own Windows machine, in terminals, VS Code, or launched from Waystation. Teams and other developers are the intended audience. They glance at the station while doing other work and come back to it when an agent needs them.

## Product Purpose
Waystation ("Agent Tower") lets a developer see and steer every coding agent on their machine from one local place. Success is knowing at a glance who is working, who is waiting, and who needs a decision, and being able to act on it (approve, edit, deny, instruct, stop, delegate) without hunting through terminals.

## Positioning
One view across vendors, with real intervention: it can hold an agent's next tool call for approval, run mixed Claude + Codex teams that share a task board in separate git worktrees, and guard against runaway loops and spend. The live agents are shown on a station canvas per project folder: each session is a node with its status, live activity and any held tool call, subagents branch from their parent, and teams are framed groups.

## Operating Context
The desktop runs locally on Windows, Node 22.20+, served on localhost with a per-start access token in a browser or Electron window. It provides setup checks, a tray, native folder selection, and attention notifications. Agents appear whether they run in a terminal, VS Code, or Waystation itself. Control level varies per agent and is shown as a badge: Full control, Hook control, Observe only. Waystation opens real Claude Code / Codex sessions in Windows Terminal tabs on handoff.

The separate hosted Architecture workspace runs API agents in Linux containers, with OIDC identity, organization roles and a dedicated worker, state, project volume and credential-encryption key per organization. It executes connected workflows with durable checkpoints, explicit approvals, bounded execution and evidence-based promotion. See docs/hosted-agent-platform.md for deployment and acceptance requirements. The reference deployment is single-host; real identity-provider login, restore, load and security acceptance require the target environment.

## Capabilities and Constraints
- Intercept tool calls: Approve, Edit input, Deny + instruct, Let agent ask.
- Send messages, interrupt/stop agents, delegate work, attach skills.
- Teams: shared task board, inter-agent messaging, git worktree sandboxes, merge on demand.
- Cost estimates, context fill, runaway guard, templates and schedules.
- Desktop is local by default, without accounts. Paired-device remote access is opt-in on the operator's private network (Tailscale Serve), with per-device View, Triage or Full permissions. The hosted Architecture workspace is a separate deployment with accounts and organization roles; native CLI and desktop control are unavailable there.
- Demo mode ("Explore the demo") shows a clearly labeled sample crew with no live actions.
- Each session keeps one identity mark (Pip, Mica, Orbit, Sprout, Bolt, Nova: a geometric glyph and color) across every view.
- The scene is a visualization; character movement never issues agent commands.

## Brand Commitments
Dark-first, minimal and modern (in the spirit of Warp and Mastra), with a light theme on request. The station is an abstract node canvas, not an illustrated scene; session identity marks are geometric glyphs. Self-hosted Geist Sans and Geist Mono (OFL, shipped in the repo). Tokens live in web/src/theme.css.

## Evidence on Hand
Screenshot at `docs/waystation.png`; README with feature and control-level tables. No testimonials, customers, benchmarks, or pricing exist; do not invent any.

## Product Principles
1. Approvals are the highest-stakes, time-sensitive action; approving or denying a held tool call must always be fast and prominent, in the scene as well as in lists.
2. Status first: working, waiting, idle, and stopped must be readable at a glance without opening anything.
3. Be honest about control: never show a control the tower cannot deliver for that agent; say where to act instead.
4. The station stays calm and scannable; anything animated has a calm fallback.
5. Local and trustworthy: secrets, tokens, and tool payloads are handled carefully and shown only on demand.

## Accessibility & Inclusion
Respect the system reduced-motion setting and offer a pause for scene animation. Keep keyboard navigation working (e.g. arrow keys between folder tabs in the full-screen station).
