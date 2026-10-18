# Teams verification

Verified on October 13, 2026; chat regression verified on October 14, 2026.

## Chat regression

Ordinary assistant replies were stored as activity, so the default conversation filter hid them. Replies now enter the visible message log; errors enter the visible system log. Mirroring a reply does not enqueue peer messages or consume wake-ups.

Paused, stopped, and finished teams queue operator messages. The conversation now offers **Send & resume**, which queues the message before resuming the team and renewing its run limits. Standing instructions explicitly permit replies to operator greetings and chat tests.

All 28 tests in `teamManager` and `teamBridge.integration` passed after this fix. Added regression coverage verifies visible replies/errors without peer wake-ups and delivery of an everyone greeting to every member after resume. The browser workflow submits “Everyone say hi,” verifies resume, and checks three fixture replies with tool activity hidden. TypeScript and the production build passed. Live model generation was not exercised by this regression run.

Restart the running Waystation daemon to load the backend change.

## Backend

All 89 tests passed across `teamManager`, `teamBoard`, `teamSandbox`, `teamWorkspace`, `teamHandoff`, and `teamBridge.integration`.

Coverage includes creation and validation, role permissions and revoked tokens, cross-vendor task assignment, busy-member message queues, pause/resume, wake-up and time limits, idle detection, failed launches, restart persistence, CLI handoff and return, worktree isolation, diff review, merging and conflict handling, disband cleanup, and the HTTP/MCP bridge.

These tests use simulated agent runners and real temporary Git repositories. They do not establish live Claude/Codex availability, model quality, or behavior in an existing user repository. No backend failure was found in this run.

## Interface

Interface overhaul verified on October 16, 2026.

Run `node scripts/verify-teams.mjs` with this repo's Vite server running (`npx vite`, port 5173). If 5173 is taken by another app, start Vite on another port (`npx vite --port 5174 --strictPort`) and set `TEAMS_VERIFY_URL=http://127.0.0.1:5174`. The browser check uses fixture API/WebSocket responses and writes desktop/mobile captures to `.impeccable/teams`.

It verifies:

- **Plan review:** the banner lists the drafted tasks with their assignees. A task title is edited inline (`POST /tasks/t1` with only the changed field). **Send feedback to lead** addresses and focuses the composer, and **Approve plan** posts `/plan/approve` and removes the banner.
- **Conversation:** messages render as "sender → recipient", with a **Queued** badge while the message id is in `pendingIds`. Replies are labelled **Reply to you** or **Reply · not sent to teammates**, and tool activity is hidden by default.
- **Task board:** the blocked-task shortcut addresses and focuses the composer, and merge stays disabled while a member waits. An operator-added task is posted with its title and assignee, and it appears on the board.
- **Composer:** while paused, **Send** posts the message without resuming. **Send & resume** posts it and resumes, and the composer shows "+20 turns, +30 min" beforehand.
- **Review:** the diff view opens. The **Merge all** confirmation explains the order (workers, then the lead) and that it stops at a conflict.
- **Archive:** archived teams are listed under **Archived** and open read-only, with no composer and no task editing. **Remove from list** posts `/remove` after a confirmation.
- **General:** no browser errors, and no horizontal page overflow at 1440px or 390px.

The interface keeps the existing cream/purple palette, Source Sans UI typography, Georgia headings, icons and button vocabulary. The team detail is split into focused components under `web/src/components/team/`. New styles are in `web/src/team-workflow.css`. No global design system change was made.
