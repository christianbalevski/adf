# Daemon backend: rules for workstream agents

Every workstream agent reads this file, `docs/design/daemon-backend.md` and its own section of `docs/design/daemon-backend-tracker.md` before writing code.

## Environment

- Work only in your own worktree, `C:\Users\Christian\repos\adf\.claude\worktrees\db-<id>`, on branch `ws/<id>`. Never touch another worktree, the main checkout or `feat/daemon-backend`.
- `node_modules` is a junction shared by all worktrees. NEVER run `npm install`, `npm ci`, `npm test`, `npm run test*`, `scripts/rebuild-for-node.mjs`, `electron-rebuild` or anything else that rebuilds native modules or edits `node_modules`. `electron-builder` packaging rebuilds native modules by default, so do not run it unless your workstream says so and you have confirmed `npmRebuild: false`.
- Tests: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run <paths>` (Git Bash). Run only the suites you touch plus the ones named in your acceptance criteria. Integration suites that bind ports MAY collide with parallel agents; retry once before treating it as a failure.
- Type-check: `npx tsc --noEmit -p tsconfig.node.json`. The baseline on `feat/daemon-backend` is **165** errors. Your branch MUST NOT add errors. Report before/after counts. For renderer code also run `npx tsc --noEmit -p tsconfig.web.json` and compare against its baseline on your branch's base commit.
- The owner's real ADF Studio and daemon may be running on this machine. Tests and manual runs MUST use isolated state (`ADF_USER_DATA_DIR`, a temp settings file, a non-default port, `ADF_SECRET_STORE=file` where supported). Never read or write the real keychain entries, the real `adf-settings.json` or port 7385. Stop every process you start; on Windows use `taskkill /T /F /PID <pid>` (plain kill leaves children).

## Code

- Embedded-mode code changes only under rules E1-E3 (design §3.2). An E1 extraction lands with a characterization test written first, in the same commit.
- Stay inside the files your workstream owns (tracker §2). If you need a change elsewhere, stop and describe it in your report instead of making it.
- New daemon routes go in `src/main/daemon/routes/*-routes.ts` and are documented in `docs/daemon/openapi.json` in the same change (add entries only, never reformat). `tests/openapi-coverage.test.ts` MUST pass.
- Match the surrounding code: comment density, naming, idioms. No silent automatic actions: log them, and show them in the UI where the user triggered the flow.
- Test fixtures use handles/names `agent-1`, `agent-2`; ids are UUIDs.
- No sync work on main-process or daemon hot paths.

## Finishing

- Commit on your branch in logical commits. End every commit message with:

  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P15Vr7jNtmnxV9fGXqca7A
  ```

- Do not push, merge or open a PR.
- Final report (≤ 400 words): what you built, each acceptance criterion with its evidence (test name or command output), tsc before/after, deviations from the design and why, anything left undone, and changes you need from other workstreams.
