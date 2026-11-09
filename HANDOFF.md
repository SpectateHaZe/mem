# Mem handoff

Written because the 5-hour Claude usage limit hit 98%. Do not commit this file (AGENTS.md: no agent scratch files in the repo).

## Goal

Mem is a fork of T3 Code (https://github.com/SpectateHaZe/mem, branch `mem-features`). The user is now using it day to day and reported two problems:

1. **"I can't see my usage left in Claude."** Mem should show the remaining Claude subscription limits (5-hour and weekly).
2. **"Don't count subscriptions as spending limit."** The daily spending cap ($20 default) must only count real pay-per-use spending, such as API keys and DeepSeek. Claude Pro/Max and ChatGPT subscription usage must not count.

## Current state

- No code has been changed for either problem. Every tool call was blocked before any file could be read.
- Last commit, pushed to `origin/mem-features`: `e2022f03 fix(server): download Obscura through the GitHub API`.
- Mem is running as a production Electron build with data in `~/.mem`, started from a terminal with:
  `$env:T3CODE_HOME = 'C:/Users/ycaga/.mem'; node apps/desktop/scripts/start-electron.mjs`
- **The user is talking to agents from inside that running Mem.** Do not stop it, and do not kill processes by name or pattern. Code changes only take effect after a rebuild and a restart of the app, so tell the user before restarting.

## Decisions and why

- **Cap (from the original build):** `apps/server/src/orchestration-v2/SpendingCap.ts` passes `sessionIds` from `projections.listRecentNativeSessionIds` (48h lookback) to `usage.readSummary`, so only Mem's own sessions count. Those costs are estimates from transcripts. That is why subscription usage counts today.
- **Proposed cap fix, not implemented or checked against the code:** exclude providers and instances authenticated by subscription (Claude Pro/Max, ChatGPT). Keep API-key usage. Transcripts probably do not record billing type, so the auth method likely has to come from provider status. Confirm this first. If auth is unknown, decide deliberately which way it fails and tell the user.
- **Stealth:** Mem bundles only the normal Obscura build, never the stealth build, because that build exists to evade bot detection. Keep it that way.
- **Releases:** do not push a tag or publish a release until the user says so. They said "Not yet" to `v0.1.8`.

## Files changed

None for this task. Relevant files, from earlier work:

- `apps/server/src/orchestration-v2/SpendingCap.ts`, `SpendingCapState.ts`
- `apps/server/src/usage/UsageService.ts` and `usageAggregation.ts` (confirm the paths)
- `packages/contracts/src/usage.ts` (`sessionIds` is optional)

## What failed

- Bash, Read and Grep all returned "Usage limit reached (five_hour 97%)" instead of running, so the cause of problem 1 is still unknown.
- Earlier today, an OpenCode desktop agent running a disk cleanup appears to have deleted `node_modules` while Mem was starting. The user stopped it. If `node_modules` goes missing again, check for that first.
- The global `vp` (1.5.0) fails against this repo's 1.4.0 ("Expected vite-plus-core@1.5.0"). Use `node_modules/.bin/vp` (`vp.cmd` from PowerShell) for builds, tests and checks.

## Next steps

1. Search for existing provider-limit code: grep `rateLimit|usageLimit|ProviderLimit|usedPercent|five_hour|fiveHour` in `apps/web/src`, `apps/server/src/provider`, `packages/provider-claude/src`, `packages/contracts/src` and `packages/client-runtime/src`.
2. Find out why Claude's remaining limits don't show in Mem. Check the Usage page and composer, and whether the rebrand, the `~/.mem` home or the settings hide them. Then fix it. Check the web and desktop clients; mobile has separate UI.
3. Read `SpendingCap.ts` and find where provider auth type is available. Filter subscription usage out of the cap total, and add a focused test for the filter.
4. Check that the Usage page labels subscription usage correctly and that the cap display matches the new total.
5. Verify with scoped commands only: `node_modules/.bin/vp test run <files>`, `node_modules/.bin/vp run --filter t3 typecheck`, `node_modules/.bin/vp run --filter "@t3tools/web" typecheck`. Do not run `vp run check:changed` here; it goes repo-wide. `serverSettings` symlink and OpenCode `status.test` failures on Windows are known and unrelated.
6. Rebuild with `node_modules/.bin/vp run --filter @t3tools/desktop --filter t3 build`, then ask the user before restarting Mem.
7. Commit and push to `mem-features` when the user asks. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use the repo-local SpectateHaZe noreply identity; no real email in public commits.

## Standing constraints

- Never write to or start a server against `~/.t3/userdata` (the user's real T3 Code data).
- Never kill processes by name or pattern.
- Do not delete or edit the user's `~/.local/share/opencode/opencode.db`.
- Do not open a PR unless asked.
