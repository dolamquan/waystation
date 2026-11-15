# Git worktrees on the canvas

Git worktrees let you work on separate branches in separate folders while sharing one repository.

Choose **New tile → Worktree**, enter a repository folder, and select an existing worktree or expand **Create a worktree**. You can create a new branch from `HEAD` (or another commit or branch), or check out an existing local branch that is not already in use. The optional destination must be a new folder with an existing parent; leaving it blank creates a sibling folder named after the repository and branch.

Choose **Open worktree tile** to save the manager on the canvas. It remembers the repository and selected worktree across reloads. From there, open Claude Code, Codex, or a console in that worktree. The manager stays available so you can open additional tiles. Closing it leaves the worktree, branch, and running terminals intact.

The tile opens with a **Worktree map** showing the shared repository and its working folders. Each node shows its branch, folder path, and current commit, with the selected worktree highlighted. Click a node to select where the next agent or console opens. **List** returns to the dropdown, and **Refresh** reloads the map from Git. The connections show folders sharing a repository; they do not imply branch ancestry or a merge.

For a regular Claude Code, Codex, or console tile, enable **Use a Git worktree** during tile creation. Select or create a worktree, then open the terminal as usual. If the terminal fails to launch, the worktree stays available for retry.

Worktrees contain committed files. Uncommitted changes remain in the original checkout. The repository needs at least one commit. Waystation does not initialize, commit, force-checkout, merge, or remove worktrees through these controls. **Refresh** picks up worktrees created outside the app.

The authenticated operator API provides `GET /api/worktrees?root=<absolute folder>` and `POST /api/worktrees` with `{ root, branch, mode: "new" | "existing", base?, path? }`. Git commands use argument arrays and disable Git hooks and filesystem monitors, matching the team workspace behavior.

See the [Git worktree documentation](https://git-scm.com/docs/git-worktree) for Git's underlying behavior.
