# Reviewer Pass Design

## Goal

Reduce the rate of broken PRs Gary lands by adding an empirical-verification reviewer pass between primary-agent finish and branch push. Catch the failure modes observed in PRs #46, #47, #48, #50: unverified fixes, half-wired features, untested logic changes.

## Non-Goals

- Catching subjective "could be cleaner" issues (style, refactor opinions, scope critique). Reviewer's mandate is bug-finding only.
- Improving the primary agent's reasoning. This is a second-stage gate, not a first-stage upgrade.
- Replacing human review on the resulting PR. This is a pre-push gate, not a substitute for code review.

## Context

Recent PR review of 6 open Gary PRs surfaced two correlated failure patterns:

1. **Plausible diffs that skip empirical verification.** PR #46 introduced a SQL parameter-index collision (`AND p.type = ?2` clobbering the `LIMIT ?2` slot); the diff included tests of constants but never executed the query. PR #50 added a service worker prewarm for `static/models/bird-image/labels.json` whose premise was wrong — the file already existed and was already fetched at runtime.
2. **Half-wired diffs.** PR #47 added a `?unidentified=true` query param at the producer side but never wired a receiver in the consumer route. PR #48 imported a dark-theme palette into a light-mode chart.

The shared signature: the primary agent pattern-matched the symptom and shipped a plausible-looking diff. It compiles, often passes the test suite (because the broken code path isn't exercised), and looks reasonable on a quick read. The bug isn't visible without running the code or grep'ing for the wired-up identifier.

## Architecture

A new `reviewer` agent runs after the existing post-finish check passes and before the rebase-and-push step in `src/handlers/code.ts`. The reviewer is a fresh agent loop with its own context, prompt, and provider-preference order.

```
primary agent loop
        ↓ finish
ensurePostFinishCheckPasses     (existing, unchanged)
        ↓ pass
reviewer pass                   (NEW)
        ↓ verdict
   ┌────────────────────────┐
   │                        │
approve                  changes_needed
   │                        │
   │                  primary re-enters loop
   │                  with reviewer findings
   │                        ↓
   │                  back to post-finish check
   │                  (up to 3 review rounds)
   │
rebase onto fresh main          (existing)
push branch                     (existing)
open PR with verification
report appended to body         (modified)
```

### Loop budget

- Up to **3 review rounds** total. After the third rejection, escalate via `escalate({ reason: "review_rejected" })` with a synthesized comment listing the final round's blockers.
- Reviewer's own iteration cap: **15** (matches the existing post-finish fix loop).
- Reviewer's own timeout: **5 minutes** per round.
- On reviewer crash or timeout: **retry once**. If still failing, **default-approve** and proceed; log a `review_failed` event so failures are observable.

### Placement rationale

Earliest gate that still has a complete diff to reason about. Branch never reaches GitHub if the reviewer rejects, so there's no PR clutter to clean up. Escalation goes to the Linear ticket with the reviewer's reasoning, giving a human a clean handoff.

## Reviewer Agent

### Model selection

Reviewer instantiates its own `GLMClient` with a different provider preference order than primary. Default primary order is `zai → kimi → deepseek`; default reviewer order is `deepseek → zai → kimi`. Configurable via new env var `GARY_REVIEWER_PROVIDER_ORDER` (comma-separated, e.g. `deepseek,kimi,zai`).

When all three providers are unarmed (the common case), the reviewer naturally lands on a different provider than primary used, giving uncorrelated blind spots. When only one provider is available (others rate-limited), the reviewer falls back to same-model-different-prompt, which still provides adversarial framing.

### Prompt mandate

Three-part prompt:

1. **Mandate.** Find ONE concrete, blocking bug. If you can't find a real bug, approve. Do NOT block on style, refactor opinions, scope critiques, or "could be cleaner" notes — those go in `advisory_notes`, never in `findings`.
2. **Bug-class definition.** A blocking finding must fall into one of:
   - **Wrong code path** — won't run, will throw, returns wrong values, off-by-one, type mismatch the typechecker missed.
   - **Unverified empirical claim** — primary said "tested X" or "verified Y" but the run-log shows X/Y was never executed.
   - **Half-wired feature** — new producer with no consumer (or vice versa); new identifier appearing only once in the codebase.
   - **Untested changed logic** — a changed exported function, SQL query, or component is not exercised by any test.
3. **Inputs.** Ticket text, full unified diff, primary's run-log (every `run` invocation, command + exit code), pre-check results, project skills frontmatter (auto-loaded the same way primary does it).

### Tool access

- **Read.** `read_file`, `grep`, view current diff. Same shapes as primary's read tools.
- **Run.** `run` — same shell tool primary has. The reviewer can verify claims empirically: run a fixture query, curl an asset, run a specific test, grep the codebase. This is the core of the design — the reviewer can actually check, not just inspect.
- **Write.** Only `submit_review`. No edit tools. The reviewer cannot patch the diff; it judges and the primary fixes.

### Output schema

`submit_review` payload:

```
{
  verdict: 'approve' | 'changes_needed',
  findings: Array<{
    title: string,           // short, ~70 chars
    detail: string,          // one paragraph, what's wrong and how to verify
    location?: { file: string, line?: number },
    bug_class: 'wrong_code_path' | 'unverified_claim' | 'half_wired' | 'untested_logic'
  }>,
  advisory_notes: string[],  // markdown bullets, never blocking
  verification_report: string  // markdown, gets appended to PR body
}
```

`findings` MUST be empty when `verdict === 'approve'`. When `verdict === 'changes_needed'`, `findings` MUST be non-empty.

## Deterministic Pre-Checks

Pre-checks run before the LLM reviewer sees anything. Their results are passed into the reviewer's prompt as structured input so the LLM can reason about them rather than re-derive them. New module `src/review/precheck.ts`. Each check is a pure function over `{ diff, worktreePath, runLog }` returning `PrecheckResult[]`.

### Check (a) — Test-changed-code

Parse the diff for new or changed exported declarations: `export function`, `export class`, `export const`, `export default`. For each, grep `test/**` for an import or string-reference of the exported name. Flag exports with no test reference as:

```
{ kind: 'untested_export', name, file, line }
```

Heuristic, deliberately conservative:
- Type-only changes (renames, signature edits without body changes) skip the check.
- Pure refactors (e.g., extracted helper that's only used internally) skip if the export is reachable from an existing tested entry point. v1 doesn't compute this — we accept some false positives and let the LLM reviewer downgrade them to advisory notes.
- An allow-list config (`GARY_REVIEW_PRECHECK_ALLOW`) lets us silence persistent false positives without changing code.

Catches the PR #46 SQL function with no SQL test, PR #48 `aggregateMonthlySpecies` with no aggregation test.

### Check (b) — Half-wired identifiers

Parse the diff for new string literals introduced as identifiers: query param names (`?foo=`), event names (`emit('foo'`), storage keys (`localStorage.setItem('foo'`), exported string consts. For each, grep the project for another occurrence outside the changed file. Flag identifiers appearing only once as:

```
{ kind: 'unwired_identifier', name, file, line }
```

The grep is intentionally project-wide — a query param produced in `+page.svelte` should be consumed somewhere; if the only hit is the producer file, it's almost certainly half-wired.

Catches PR #47's `unidentified=true` query param with no receiver.

### Check (c) — Run-log review

The primary agent's loop already invokes a `run` tool. v1 adds a `RunLogEntry[]` to the loop's return value, capturing `{ cmd: string, exit: number, ts: number }` for each `run` invocation. Stdout is NOT included — it's enormous and the reviewer doesn't need it for this check; what matters is whether the relevant code path was executed at all.

The reviewer receives the run-log in its prompt as `run_log: Array<{ cmd, exit, ts }>` and is responsible for noticing patterns like:

> Primary's commit message claims "verified the SQL returns the expected rows" but the run-log contains no query execution.
> Primary added a service worker prewarm for `labels.json` but never ran a fetch for that path.

This is the core defense against PR #46 and PR #50 class bugs.

### Check (d) — Tests/typecheck pass

`ensurePostFinishCheckPasses` already runs `bun run check` and re-enters the agent loop on failure (up to 15 attempts). If we reach the reviewer at all, this is by construction passed — the existing flow bounces before reviewer if the check is permanently failing.

The reviewer prompt includes `check_status: 'passed'` as a known-good signal. The point isn't a redundant gate; it's setting expectation for the LLM ("the code compiles and tests pass — your job is to find what compiles-and-passes-tests bugs are still in here").

### Skipped in v1

- **Raw-hex regex on Svelte style blocks.** Project-specific (bird/ertai). The LLM reviewer should catch this from the project's CLAUDE.md skill rather than us hardcoding the regex.
- **Coverage analysis on changed lines.** Too heavy for v1.
- **AST-based diff analysis.** Regex over diff text is good enough for the v1 checks above.

## Run-Log Capture

Modify `src/agent/loop.ts` to track `run` tool invocations in a `RunLogEntry[]`:

```ts
export interface RunLogEntry {
  cmd: string;       // command + args, redacted via redactGitHubTokens
  exit: number;      // exit code
  ts: number;        // ms since epoch
}
```

Push a record on each tool dispatch where the tool name is `run`. Expose alongside the existing loop return value (e.g., `{ ...existing, runLog }`). Tokens in commands are already redacted at the `gitMust` level; the run-log applies the same redaction to be safe.

## PR Body Integration

`PR_BODY_TASK_INSTRUCTIONS` in `src/handlers/code.ts` gets a new template slot for the reviewer's `verification_report`. Final PR body shape becomes:

```
## Summary
{primary-authored summary}

## Test plan
{primary-authored checklist}

## Verification
{reviewer.verification_report}

closes [TICKET]

i'm gary, an autonomous agent — review carefully, but i did my best.

🤖 Generated by [gary-707-labs]
```

When the reviewer fails (default-approve path), `verification_report` is replaced with `_reviewer pass unavailable for this PR_` so the absence is explicit, not silent.

## Persistence

New SQLite table `review_passes`, one row per reviewer invocation:

```sql
CREATE TABLE review_passes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  round           INTEGER NOT NULL,         -- 1, 2, or 3
  verdict         TEXT NOT NULL,            -- 'approve' | 'changes_needed' | 'failed'
  finding_count   INTEGER NOT NULL,
  advisory_count  INTEGER NOT NULL,
  provider_used   TEXT,                     -- 'zai' | 'kimi' | 'deepseek' | NULL on fail
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  duration_ms     INTEGER NOT NULL,
  escalated       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_review_passes_issue ON review_passes(issue_id);
CREATE INDEX idx_review_passes_verdict ON review_passes(verdict, created_at);
```

Migration in `src/state/migrations.ts`.

A new event type `review_decision` is also emitted to the existing `events` table per round, payload `{ verdict, round, finding_count }`. Lets `bun run logs`-style consumers see the rejection rate at a glance without joining tables.

## Escalation

New `EscalationReason` value `review_rejected` in `src/escalate.ts`. Default message:

```
took 3 swings at this and the reviewer kept finding issues.
bouncing so a human can decide whether to retry, split, or fix
directly. last round's blockers:
- {finding 1 title}
- {finding 2 title}
- {finding 3 title}
```

The reviewer's `findings[].title` field is what gets spliced in — keep titles short on the reviewer side so the escalation comment stays scannable.

## Configuration

New env vars (all optional, sensible defaults):

| Var | Default | Purpose |
|---|---|---|
| `GARY_REVIEWER_PROVIDER_ORDER` | `deepseek,zai,kimi` | Comma-separated provider preference for reviewer |
| `GARY_REVIEW_MAX_ROUNDS` | `3` | Cap on review iterations before escalation |
| `GARY_REVIEW_ITERATION_CAP` | `15` | Reviewer agent loop iteration cap per round |
| `GARY_REVIEW_TIMEOUT_MS` | `300000` | Reviewer per-round timeout (5 min) |
| `GARY_REVIEW_PRECHECK_ALLOW` | `""` | Comma-separated allow-list for pre-check false-positive silencing |

Documented in `.env.example` and `CLAUDE.md`'s Environment section.

## Failure Modes & Backstops

| Failure | Behavior |
|---|---|
| Reviewer crashes (exception thrown) | Retry once; if second crash, default-approve, log `review_failed` event |
| Reviewer times out (>5 min on a round) | Same as crash |
| Reviewer iteration_cap fires | Same as crash |
| Reviewer returns malformed JSON (no `submit_review` call) | Treated as crash; same retry-then-approve path |
| Provider chain fully exhausted (all 429) | `AllProvidersExhaustedError`; treated as crash; retry-then-approve |
| Primary fails to fix after a `changes_needed` verdict | Counts as a round; reviewer evaluates whatever the next iteration produces |
| 3 rounds rejected | Escalate via `escalate({ reason: 'review_rejected' })` |
| Pre-check throws (unexpected diff shape, etc.) | Log + skip that pre-check; reviewer proceeds without that input |

The fail-open default (default-approve on reviewer failure) is a deliberate calibration choice: the v1 goal is to catch the specific class of bugs we've observed, not to gate every PR on a working reviewer. If `review_failed` events become noisy, the next iteration flips this to fail-closed.

## Calibration

The `review_passes` table is the calibration surface. Useful queries:

- **Rejection rate by round.** `SELECT round, verdict, COUNT(*) FROM review_passes GROUP BY round, verdict;` — high `changes_needed` on round 1 with high `approve` on round 2 is healthy. High `changes_needed` carrying through round 3 means the reviewer is too aggressive or the primary can't act on its feedback.
- **Provider effectiveness.** `SELECT provider_used, verdict, COUNT(*) FROM review_passes GROUP BY provider_used, verdict;` — does one provider catch more bugs?
- **Failure rate.** `SELECT COUNT(*) FROM events WHERE type = 'review_failed' AND created_at > datetime('now', '-7 day');` — sanity-check fail-open is fine.

No automated alerting in v1. Tanner reads the table manually until we know what "too aggressive" actually looks like.

## Open Risks

1. **Reviewer becomes a de-facto pessimism gate.** The "Defaults to ambition" voice principle (added 2026-04-26) explicitly says don't bounce on size. A strict reviewer that escalates after 3 rounds could undo that. Mitigations: narrowed mandate (bug-finding only), bug-class definition (no scope/style blockers), and the calibration table (catch this in data, not by guessing).
2. **Cost increase.** Soft-targeting 30k input tokens per reviewer round on top of the existing primary loop. On the 250k-token tickets we already see, that's a ~12% bump per round. Acceptable for the bug-catching goal; revisit if the rate of `failed_after_max_attempts` from primary climbs (suggests primary is leaving more headroom for itself).
3. **Run-log false confidence.** A `run` invocation with the right command shape doesn't guarantee the right code path was exercised — primary could run `bun test foo.test.ts` against an unrelated test. The LLM reviewer is responsible for noticing this. v1 doesn't try to be cleverer than that.
4. **Pre-check false positives.** "Untested export" will fire on extracted helpers and re-exports. The allow-list (`GARY_REVIEW_PRECHECK_ALLOW`) is the escape valve; expect to populate it after first contact with real tickets.

## Out of Scope

- Stacked PR support (deferred from earlier brainstorm; one chunky PR remains the model)
- Reviewer-driven edits (Q5 option C; reviewer judges, primary fixes)
- AST-based pre-checks
- Coverage analysis on changed lines
- Auto-tuning the reviewer prompt based on calibration data
