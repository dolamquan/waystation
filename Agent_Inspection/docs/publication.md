# Preparing the GitHub repository

The current working tree has been checked for configured credential patterns, runtime files, and the current user's absolute profile path. Historical Git blobs were reviewed separately. Older `.playwright-mcp` captures and logs contain local paths and remain in the existing history. The review script prints file/object references, never matched values.

Use a fresh source export for the initial GitHub publication:

```powershell
cd Agent_Inspection
npm run export:source
```

The command checks the working tree and creates a `Waystation` source folder and, on Windows, `Waystation-source.zip` under the repository's ignored `.waystation-export` folder. It copies current source, documentation, the lockfile, and the GitHub workflow. It excludes Git history, local browser captures, installed dependencies, build output, verification artifacts, and runtime data. Your original repository/history stays intact. The exported folder is ready to initialize as a new repository; its own README contains the clone/setup instructions.

Review the exported files before publishing, then initialize Git in that exported `Waystation` folder and connect the GitHub repository you choose. Users will run `npm ci` and `npm run desktop` from `Agent_Inspection`. Do not include your Waystation data directory, agent session folders, environment files, or installed dependencies.

Useful checks from the application folder:

```powershell
npm run check:publication
npm run check:publication -- --history
```

The second command reports findings in reachable history as well as current source. It does not rewrite commits or remove files. The configured patterns are a review aid and do not certify the absence of every possible secret. Source exports omit historical captures even when their tokens are no longer active.

A project license remains undecided, as requested. Dependency and font license notices remain with their owners; the included Source Sans 3 notice is preserved.
