# CLAUDE.md

Gary is a single Bun process that polls Linear every 60s, classifies tickets
assigned to him, opens PRs against `707-Labs/ertai`, and self-fixes CI
failures. Source of truth is Linear + GitHub; SQLite (`~/.gary/state/gary.db`)
is operational state and is safe to wipe.

See `GARY_SPEC.md` for the full architecture and `voice.md` for personality.

## Commands

```sh
bun run start        # run gary locally (will act on real tickets — see "don't do")
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test             # all unit tests
bun run deploy       # ssh mini → git pull → install → typecheck → reload launchd
bun run logs         # tail gary's stdout on the mini
```

Read-only probes (safe to run anytime against live services):

```sh
bun run scripts/probe-linear.ts          # verify Linear auth + list assignments
bun run scripts/probe-github.ts          # verify App auth + list own PRs
bun run scripts/probe-github-raw.ts      # diagnostic; raw fetch with installation token
bun run scripts/probe-glm.ts             # chat + tool use against Z.ai
bun run scripts/probe-classifier.ts      # classifier on fixture tickets (no Linear writes)
bun run scripts/probe-agent-loop.ts      # agent loop in temp workspace
bun run scripts/probe-loop-tick.ts       # ONE real tick — will post comments / open PRs
bun run scripts/probe-ticket-details.ts  # print descriptions of Gary's current assignments
bun run scripts/probe-cloudflare.ts      # verify CF observability auth + recent errors
```

## Architecture (one-liner)

`src/index.ts → src/loop.ts (every 60s) → derive state per ticket → pickActionForTicket → dispatch handler`. Handlers in `src/handlers/{classifier,code,ci-failure,answer,bounce}.ts`. Coding handlers run an agent loop (`src/agent/loop.ts`) with tools (`src/agent/tools.ts`) bound to an `Executor` (`src/executors/`).

## Key files

- `voice.md` — Gary's personality. Loaded verbatim into every system prompt. Update this, not individual prompts.
- `src/handlers/code.ts` — has `PR_BODY_TASK_INSTRUCTIONS` and `PR_TITLE_TASK_INSTRUCTIONS` constants for PR style. Format is Claude-Code structural with Gary's voice.
- `src/state-fingerprint.ts` — hashes derived state for idempotence; `(issueId, fingerprint, actionType)` keys the action cache.
- `src/priority.ts` — action priority logic, mirrors GARY_SPEC.md §6.
- `~/.gary/secrets/gary-707-labs.pem` — GitHub App private key (NOT in repo, gitignored).

## Environment

`.env` required keys: `LINEAR_API_KEY`, `GARY_LINEAR_USER_ID`, `LINEAR_TEAM_ID`, `LINEAR_IN_PROGRESS_STATE_ID`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (or inline `GITHUB_APP_PRIVATE_KEY`), `GITHUB_APP_INSTALLATION_ID`, `Z_AI_API_KEY`. Optional: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` to enable Workers Observability tools (`query_cloudflare_logs`, `list_cloudflare_invocations`) inside the agent loop. See `.env.example`.

`src/config.ts` exposes per-subsystem loaders (`loadLinearConfig`, `loadGitHubConfig`, `loadCloudflareConfig`, etc.) so probes can load only what they need. `loadCloudflareConfig` returns `null` when the token isn't set — Gary runs fine without it, just without log access.

## Gotchas

- **Bare clones**: pass `main` (not `origin/main`) as base branch. Bare repos track refs at `refs/heads/*` directly — there's no remote-tracking namespace.
- **Fetch refspec**: `ensureBareClone` fetches only `+refs/heads/main:refs/heads/main`. A wildcard refspec fails when any branch is checked out in a worktree.
- **Linear duplicate attachments**: Linear auto-detects `[TICKET]` in PR bodies and creates an attachment. Our manual `addPrAttachment` then 409s. The handler swallows duplicate errors — see `src/handlers/code.ts`.
- **bun:sqlite strict mode**: parameters are passed without `$` prefix: `query.run({ key: value })`, not `{ $key: value }`. SQL still uses `$key` style.
- **Pre-push hook runs `bun run check`** in the Ertai repo. The agent loop must typecheck before calling `finish` or push will fail. See `CODE_TASK_INSTRUCTIONS`.
- **GitHub App create form drops permissions**: the create wizard often saves an App with no permissions even when you set them. Set them again on the live Permissions page after creation, then accept the new permissions on the installation.
- **voice.md is cached at module init** (`src/agent/prompts.ts`). Restart Gary to pick up changes.
- **Action cache filters by `success = 1`**. Failed actions don't block retry, so a deterministically-broken handler will loop until the circuit breaker (5 attempts in 6h) fires.
- **`Executor` interface uses `run`** rather than the spec's name for the method that runs shell commands. Diverges from the spec to dodge a security-scan false positive on a common substring.
- **Cloudflare observability is opt-in**: tools only register if `CLOUDFLARE_API_TOKEN` is set. The Workers Logs API only returns data for workers that have `observability.logs.enabled` in their wrangler config. Mulligan-labs workers all have it on with `upload_source_maps: true`, so stack traces come back de-minified.

## Voice

- Update `voice.md`, not individual prompts. The prompts compose voice + task instructions + context.
- PR style: `## Summary` + `## Test plan` checklist + `closes [TICKET]` + parenthetical "i'm gary" honesty line + `🤖 Generated by [gary-707-labs]` footer. Title is conventional commits with `(TICKET)` suffix. Examples in `voice.md` examples 5/6.
- For ANSWER tickets, the classifier-time comment IS the answer (per voice.md example 3). The `write_answer` handler does a deeper read-only investigation pass and posts a follow-up.

## Deploy / service

Gary runs on the Mac mini as `com.707labs.gary` LaunchAgent. Plist in `scripts/com.707labs.gary.plist`. Logs at `~/Library/Logs/gary/{stdout,stderr}.log` on the mini. State at `~/.gary/` on the mini.

`bun run deploy` is the canonical update path — it pulls latest from `707-Labs/gary` (private), installs, typechecks, syncs the plist if it changed, reloads launchd. The script uses `git pull --ff-only` so it refuses to advance if the mini has local changes.

Auth on the mini is a read-only deploy key (`mini-deploy` on `707-Labs/gary`) used via SSH config alias `Host github.com-gary`.

## Don't do (Weekend 1 non-goals)

`GARY_SPEC.md §16` lists explicit non-goals. Most-relevant:
- No `DockerExecutor` (interface exists, implementation is a stub)
- No webhook receivers — polling is fine
- No automatic merging of Gary's own PRs (architectural, not deferred)
- No multi-repo support
- No rebase-on-main automation

If you're about to build any of these, stop and flag to Tanner.

## When something breaks

1. Check `~/Library/Logs/gary/stderr.log` on the mini (`bun run logs` shows stdout).
2. Check SQLite: `sqlite3 ~/.gary/state/gary.db 'SELECT * FROM events ORDER BY id DESC LIMIT 20;'`
3. To pull a ticket out of Gary's queue without code changes: reassign in Linear, OR `UPDATE tickets SET terminal_state='escalated' WHERE identifier='ERT-XXXX';`
