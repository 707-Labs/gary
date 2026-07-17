# CLAUDE.md

Gary is a single Bun process that polls Linear every 60s, classifies tickets
assigned to him, opens PRs against the matching `707-Labs` repository
(team key → repo via `GARY_REPO_MAP`), and self-fixes CI failures. Source
of truth is Linear + GitHub; SQLite (`~/.gary/state/gary.db`) is operational
state and is safe to wipe.

See `GARY_SPEC.md` for the full architecture and `voice.md` for personality.

## Commands

```sh
bun run start        # run gary locally (will act on real tickets — see "don't do")
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test             # all unit tests
bun run deploy       # git pull → install → typecheck → reload launchd (runs locally on the mini, ssh's otherwise)
bun run logs         # tail gary's stdout (local on the mini, ssh otherwise)
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
bun run scripts/probe-d1.ts              # verify D1 read auth + SELECT-only clamp
```

## Architecture (one-liner)

`src/index.ts → src/loop.ts (every 60s) → derive state per ticket → pickActionForTicket → dispatch handler`. Handlers in `src/handlers/{classifier,code,ci-failure,pr-review,pickup,answer,bounce}.ts`. Coding handlers run an agent loop (`src/agent/loop.ts`) with tools (`src/agent/tools.ts`) bound to an `Executor` (`src/executors/`). The loop also pulls @mentioned tickets via `linear.fetchMentionedIssues` when an allowlist is configured — see `src/mention.ts` for the pickup/answer trigger detection.

## Reviewer pass

After the primary agent finishes and `bun run check` passes, a fresh
reviewer agent (different provider preference: DeepSeek first by
default, configurable via `GARY_REVIEWER_PROVIDER_ORDER`) reviews the
diff before push. It has read+run+submit_review tools — it can verify
claims by running tests/queries/fetches but cannot edit code.

The reviewer's mandate is narrow: it can only block on bug-class
findings (wrong code path, unverified claim, half-wired feature,
untested changed logic). Style and refactor opinions go in
advisory_notes, never findings.

On changes_needed, the primary re-enters its loop with the findings
as the new task. After `GARY_REVIEW_MAX_ROUNDS` (default 3) rejected
rounds, the ticket is escalated via review_rejected.

On reviewer crash/timeout, retry once. On second failure, default-
approve with a placeholder verification report. Calibration is via
the `review_passes` table.

Files: `src/review/{precheck.ts, tools.ts, prompts.ts, runner.ts}`,
`src/state/review-queries.ts`. Wired in `src/handlers/code.ts` between
`ensurePostFinishCheckPasses` and the rebase block.

## Key files

- `voice.md` — Gary's personality. Loaded verbatim into every system prompt. Update this, not individual prompts.
- `src/handlers/code.ts` — has `PR_BODY_TASK_INSTRUCTIONS` and `PR_TITLE_TASK_INSTRUCTIONS` constants for PR style. Format is Claude-Code structural with Gary's voice.
- `src/state-fingerprint.ts` — hashes derived state for idempotence; `(issueId, fingerprint, actionType)` keys the action cache.
- `src/priority.ts` — action priority logic, mirrors GARY_SPEC.md §6.
- `~/.gary/secrets/gary-707-labs.pem` — GitHub App private key (NOT in repo, gitignored).

## Environment

`.env` required keys: `LINEAR_API_KEY`, `GARY_LINEAR_USER_ID`, `LINEAR_TEAM_ID`, `LINEAR_IN_PROGRESS_STATE_ID`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (or inline `GITHUB_APP_PRIVATE_KEY`), `GITHUB_APP_INSTALLATION_ID`, `Z_AI_API_KEY`, `GARY_REPO_MAP`. Optional fallback providers: `KIMI_API_KEY` (Kimi Code, defaults to `https://api.kimi.com/coding` + `kimi-for-coding`), `DEEPSEEK_API_KEY` (defaults to `https://api.deepseek.com/anthropic` + `deepseek-v4-pro`). Optional: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` to enable Workers Observability tools (`query_cloudflare_logs`, `list_cloudflare_invocations`) inside the agent loop. `GARY_ALLOWLISTED_MENTION_USER_IDS` (comma-separated Linear user ids) opts into the @mention pipeline — empty (default) disables it. Reviewer pass env vars (all optional): `GARY_REVIEWER_PROVIDER_ORDER`, `GARY_REVIEW_MAX_ROUNDS`, `GARY_REVIEW_ITERATION_CAP`, `GARY_REVIEW_TIMEOUT_MS`. See `.env.example`.

`src/config.ts` exposes per-subsystem loaders (`loadLinearConfig`, `loadGitHubConfig`, `loadCloudflareConfig`, etc.) so probes can load only what they need. `loadCloudflareConfig` returns `null` when the token isn't set — Gary runs fine without it, just without log access.

## Gotchas

- **Bare clones**: pass `main` (not `origin/main`) as base branch. Bare repos track refs at `refs/heads/*` directly — there's no remote-tracking namespace.
- **Fetch refspec**: `ensureBareClone` fetches only `+refs/heads/main:refs/heads/main`. A wildcard refspec fails when any branch is checked out in a worktree.
- **Linear duplicate attachments**: Linear auto-detects `[TICKET]` in PR bodies and creates an attachment. Our manual `addPrAttachment` then 409s. The handler swallows duplicate errors — see `src/handlers/code.ts`.
- **bun:sqlite strict mode**: parameters are passed without `$` prefix: `query.run({ key: value })`, not `{ $key: value }`. SQL still uses `$key` style.
- **Pre-push hook runs `bun run check`** in the Ertai repo. `code.ts` re-runs the same command after the agent finishes; if it fails, a fix-up agent loop (15 iter cap) gets the failure output as a new task and tries to recover. If it still fails, Gary escalates with a tail of the check output instead of letting the push hook reject the branch with no recourse. See `ensurePostFinishCheckPasses` in `src/handlers/code.ts`.
- **Rebase onto fresh main happens between post-finish check and push** (`rebaseOntoFreshBase` in `src/git.ts`). Degrades gracefully: rebase conflict → push un-rebased branch + warn; post-rebase check fails → `git reset --hard <preRebaseSha>` + push pre-rebase + warn. Never fails the run.
- **Stale PR nudging** is priority 7 in `src/priority.ts`. Fires when an open, non-draft PR has CI green, no pending review comments, and has been open longer than `STALE_PR_HOURS` (default 72). The `openedAt` timestamp is carried on `DerivedPrState` but deliberately NOT included in `fingerprintDerivedState`'s canonical — it's constant per PR, so adding it would only bloat the hash. Idempotence comes from the action cache: once Gary nudges, the fingerprint stays stable until something material changes (new commit, CI flip, new comment, new Linear comment), so he won't re-nudge.
- **GitHub App create form drops permissions**: the create wizard often saves an App with no permissions even when you set them. Set them again on the live Permissions page after creation, then accept the new permissions on the installation.
- **voice.md is cached at module init** (`src/agent/prompts.ts`). Restart Gary to pick up changes.
- **Action cache filters by `success = 1`**. Failed actions don't block retry, so a deterministically-broken handler will loop until the circuit breaker (5 attempts in 6h) fires.
- **`Executor` interface uses `run`** rather than the spec's name for the method that runs shell commands. Diverges from the spec to dodge a security-scan false positive on a common substring.
- **Cloudflare observability is opt-in**: tools only register if `CLOUDFLARE_API_TOKEN` is set. The Workers Logs API only returns data for workers that have `observability.logs.enabled` in their wrangler config. Mulligan-labs workers all have it on with `upload_source_maps: true`, so stack traces come back de-minified.
- **Project context auto-load**: every coding handler prepends CLAUDE.md / AGENTS.md / `.claude/skills/*/SKILL.md` frontmatter from the worktree to the agent's task message. The agent loads skill bodies on demand via `read_file`. Implemented in `src/skills.ts`. Regex parsing uses `String.match` not `RegExp.exec` to dodge the same security-scan false positive as `Executor.run`.
- **Comment-based fingerprints excise non-human writes**: `humanInputSignature` (Linear) hashes non-Gary comment ids; `prCommentSignature` (GitHub) hashes only `User`-typed comments — bots are filtered entirely (Gary, linear[bot] linkbacks, dependabot, etc.). Without this, ANSWER and PR-review tickets would loop because Gary's own response bumps `updatedAt` / adds a comment and shifts the cache. PR review responses are also tracked in `pr_comment_responses` so the signature returns "empty" once Gary has answered every pending human comment. See `src/state-fingerprint.ts`.
- **Revisit marks gate `revisit_code`**: `ticket_revisit_marks` stores the `humanInputSignature` Gary acted on when `start_coding` ran; `revisit_code` only fires when the current signature differs. Pre-feature tickets without a mark stay dormant by design — back-filling the mark to "current" would silently drop comments Gary missed. See `src/state/queries.ts:getRevisitMark`.
- **GitHub App viewer login has the `[bot]` suffix**: `getViewer()` for App auth returns `${slug}[bot]` (e.g. `gary-707-labs[bot]`), not the bare slug — that matches the login GitHub attaches to comments authored via the installation token. The bare slug looped pr-review on the first deploy.
- **LLM provider chain (Z.ai → Kimi Code → DeepSeek)**: `GLMClient` owns a `ProviderChain` (`src/providers.ts`). `complete()` and `createMessage()` route through the highest-priority unarmed provider; on a 429 they arm that provider's gate and fall through to the next. A 401/403 (expired or revoked key) also falls through, arming the provider for `AUTH_FAILURE_BACKOFF_MS` (6h) with an error-level log — a dead fallback key must never kill a run. Other errors (5xx, malformed) still propagate. Per-provider `parse429` extracts a reset timestamp when possible (Z.ai's `code=1308` shape; Kimi a permissive ISO matcher; DeepSeek always null since it has no documented cap). Falls back to `defaultBackoffMs` (60s default) when no parse. `AllProvidersExhaustedError` only fires when every provider is armed; the tick catches it, emits `rate_limit_skip`, records the action as a non-bouncing failure so it retries with the same fingerprint when a provider clears. Tests live in `test/glm-fallback.test.ts` + `test/providers.test.ts`. **Note Kimi Code ≠ Moonshot Open Platform** — different billing surface, different endpoint (`api.kimi.com/coding` vs `api.moonshot.ai/anthropic`).
- **Scope=L on a CODE classification auto-bounces** at classification time. The classifier prompt asks the model to prefer BOUNCE on L, but it doesn't always listen (ERT-1648 burned 617k input tokens before iteration_cap fired). `decideClassifyOutcome` in `src/handlers/classifier.ts` enforces the rule, and the bounce comment splices in the model's own reasoning so the message is specific.
- **Reassigning a concluded ticket to Gary reopens it**: `terminal_state` (bounced/escalated) blocks dispatch, but the tick's per-issue loop calls `reopenTicket` if it sees a terminal-state ticket back in `fetchAssignedIssues` — that means a human reassigned it. `terminal_state` is cleared; for `bounced` tickets the classification is also cleared so the classifier re-runs with the new context. The action cache (`success=1` fingerprint match) blocks identical retries, so a no-context-change reassign is a no-op.
- **A fresh @mention also reopens a concluded ticket**: the mention scan no longer skips terminal-state tickets. A new allowlisted pickup/mention comment whose fingerprint hasn't been acted on clears `terminal_state` via the same `reopenTicket` path (mirrors reassignment) and dispatches. Already-handled mentions keep their fingerprint and stay suppressed by the action cache. Retry phrasings ("@gary try this one again", "retry this", "another crack/shot/go") count as pickup triggers — see `src/mention.ts`.
- **Reviewer agent's task arg is large**: includes diff (up to 30KB), run-log of every primary command, pre-check findings, and previous-round findings. Cache breakpoints land on the system prompt, tool list, and last user message — re-runs are cheap.
- **Run-log is captured but stdout is not**: `RunLogEntry` records command + exit + ts. The reviewer reasons about *whether* the primary ran a thing, not what it returned. Empty run-log on a non-trivial diff is a strong unverified-claim signal — reflected in the reviewer task render.

## Voice

- Update `voice.md`, not individual prompts. The prompts compose voice + task instructions + context.
- PR style: `## Summary` + `## Test plan` checklist + `closes [TICKET]` + parenthetical "i'm gary" honesty line + `🤖 Generated by [gary-707-labs]` footer. Title is conventional commits with `(TICKET)` suffix. Examples in `voice.md` examples 5/6.
- For ANSWER tickets, the classifier-time comment IS the answer (per voice.md example 3). The `write_answer` handler does a deeper read-only investigation pass and posts a follow-up. The agent has Linear admin tools (`unassign_self`, `set_ticket_state`, `update_ticket_description`) for follow-up requests like "drop to backlog and add a summary" — without these the model would fabricate compliance.

## Long-loop hygiene

- **TodoWrite (`todo_write` tool)**: agent maintains its own `[{content, status}]` task list in `AgentTools.todos`. Surfaced as a trailing text block on every tool_results turn so it stays anchored even after microcompaction. See `src/agent/tools.ts` `todoWriteTool` and `renderTodos`. The list lives only in the loop run; not persisted.
- **Microcompaction**: every 6 iterations starting at iter 12, old tool_results from "noisy" tools (`read_file`, `grep`, `run_bash`, `fetch_url`, `list_files`, `get_pr`, `get_linear_issue`, Cloudflare/D1 reads) get replaced with a placeholder. Keeps the last 6 untouched. Each compaction event invalidates the prompt cache once, then subsequent turns benefit from a smaller cached prefix. Excluded from compaction: write/edit/commit (short confirms anyway), `todo_write`, `finish`, Linear mutation tools. See `src/agent/microcompact.ts`.
- **Sub-agent dispatch (`dispatch_subagent` tool)**: spawns a fresh read-only agent loop with the parent's GLM client, executor, and read-only deps. Used for one-off investigations ("find every caller of X") that would otherwise pollute the main transcript with grep results. 1-deep recursion guard via `disableSubagent`. Read-only enforcement at the toolset level (`readOnly` flag in `ToolsetOptions` skips write_file/edit_file/commit/Linear-mutation tools). See `runSubagent` in `src/agent/loop.ts`.

## Deploy / service

Gary runs on the Mac mini as `com.707labs.gary` LaunchAgent. Plist in `scripts/com.707labs.gary.plist`. Logs at `~/Library/Logs/gary/{stdout,stderr}.log` on the mini. State at `~/.gary/` on the mini.

`bun run deploy` is the canonical update path — it pulls latest from `707-Labs/gary` (private), installs, typechecks, syncs the plist if it changed, reloads launchd. The script uses `git pull --ff-only` so it refuses to advance if the mini has local changes.

Auth on the mini is a read-only deploy key (`mini-deploy` on `707-Labs/gary`) used via SSH config alias `Host github.com-gary`.

## Don't do (Weekend 1 non-goals)

`GARY_SPEC.md §16` lists explicit non-goals. Most-relevant:
- No `DockerExecutor` (interface exists, implementation is a stub)
- No webhook receivers — polling is fine
- No automatic merging of Gary's own PRs (architectural, not deferred)
- ~~No multi-repo support~~ — implemented 2026-04-25 via `GARY_REPO_MAP` (ERT/BIRD/GREEN under the 707-Labs org)

If you're about to build any of these, stop and flag to Tanner.

## When something breaks

1. Check `~/Library/Logs/gary/stderr.log` on the mini (`bun run logs` shows stdout).
2. Check SQLite: `sqlite3 ~/.gary/state/gary.db 'SELECT * FROM events ORDER BY id DESC LIMIT 20;'`
3. To pull a ticket out of Gary's queue without code changes: reassign in Linear, OR `UPDATE tickets SET terminal_state='escalated' WHERE identifier='ERT-XXXX';`
