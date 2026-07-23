# Plan: route Gary's coding through the pi harness

Status: proposed (2026-07-23). Owner: tanner. Supersedes the GLM/kimi/deepseek
coding loop as Gary's default execution engine.

## Thesis (grounded in data pulled 2026-07-22/23)

- `iteration_cap` is **44 of 54 escalations (81%)** — Gary's dominant failure mode.
- Of the **35 tickets** that hit the cap, only **7 ever reached Done, and just 1
  (ERT-1881) by Gary himself**. The other 28 bounced to a human.
- Root cause is not the cap value — it's a **weak model in a flat loop**. Gary's
  coding runs entirely on budget open-weight models (glm-4.6/5.2, kimi k3,
  deepseek-v4-pro) in a single 50-iteration loop with a plan/investigate phase
  bolted on.
- **Spike (2026-07-23):** pi (`openai-codex/gpt-5.6-sol`, plan → scout → impl →
  validate) one-shot **ERT-1574**, which Gary hit the cap on twice and never
  landed. Clean shared-component extraction, real test, full suite green,
  colored decks provably unchanged. Shipped as PR #530.

Conclusion: replace the coding engine, not the cap.

## The seam

`runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult>` (`src/agent/loop.ts:204`)
is the single execution primitive. Six call sites:

- `src/handlers/code.ts:371` — main coding run
- `src/handlers/code.ts:863`, `:1207` — fixups
- `src/handlers/ci-failure.ts:138`
- `src/handlers/pr-review.ts:164`
- `src/handlers/answer.ts:101`

**Strategy:** build a second executor `runPiLoop(args): Promise<AgentLoopResult>`
with the identical signature and route call sites to it behind config. Gary's
orchestration — Linear polling, worktree setup, git, PR creation, CI-retry,
review gating — is untouched. Only the "write the code" step changes.

## Architecture

`runPiLoop(args)`:

1. Materialize `args.task` + `args.systemPrompt` into a prompt file in the
   worktree the `Executor` already points at.
2. Shell out headless:
   `pi -p --mode json --model openai-codex/gpt-5.6-sol --approve @taskfile`
   in that cwd.
3. Map `args.finishGateCommand` → an explicit "run this; it must exit 0 before
   you finish" instruction. pi self-verifies (confirmed in the spike).
4. Parse pi's JSON result → `AgentLoopResult` (summary, iterations, status).
   Non-zero exit / empty diff → `status: 'no_finish'` so Gary's existing
   escalation path still fires.

### Impedance mismatches (handle explicitly)

- **In-loop Linear/GitHub/CF tools** (`unassign_self`, `get_pr`,
  `query_cloudflare_logs`) aren't native to pi. For coding they rarely matter —
  pi needs edit + bash in the worktree. Bridge later via pi MCP if a real need
  shows up. Not v1.
- **Phased investigate→implement** is pi's internal plan→scout→impl→validate.
  Drop Gary's `phases` when routing to pi; pi does it better natively.
- **Auth/reliability:** pi depends on `~/.pi/agent/auth.json` (openai-codex
  subscription) + network. Preflight-check pi availability; on failure, fall
  back to the GLM loop so a pi outage degrades rather than halts Gary.

## Rollout (revised per decisions 2026-07-23)

Skipping the shadow/Phase-1 comparison: the GLM baseline is already known-bad
(81% cap), so A/B signal would be theater. Going straight to pi as default.

- **Phase 0 — executor + flag.** Add `runPiLoop`, gate with
  `GARY_CODING_ENGINE=glm|pi` (temporary; default flips to `pi`). Preflight +
  GLM fallback wired in from the start.
- **Phase 1 — pi is the default coding engine.** Route all coding + fixup +
  CI-failure call sites through pi. GLM stays only as the fallback path.
- **Phase 2 — reviewer through pi.** Route the reviewer role
  (`src/review/runner.ts`) through pi as well. This also **decorrelates the
  same-model self-review blind spot** (Gary currently authors and reviews with
  the same weights) — which matters more now that Gemini's PR review is going
  away and Claude's manual pass + pi's reviewer become the only gates.
- **Leave cheap.** Classification and stale-PR nudges stay on GLM — single-shots
  that never hit the cap; frontier spend there is pure waste.

## Cost

No ceiling. pi runs on a flat openai-codex **subscription**, not metered — so
per-run cost is not a constraint and there's no per-day budget to enforce.

## Success metrics (vs. baseline pulled tonight)

- `iteration_cap` share of escalations: **81% → target <30%**.
- cap-hit → completion rate: **~3% → target >60%**.
- human-reassignment rate on Gary tickets: down (fewer bounces).

Report these with sample size; do not call a win on a handful of runs.

## Risks

- **pi CLI version drift** (currently 0.80.10) changing `-p --mode json` output
  shape → pin/verify the parse contract, fail closed to `no_finish`.
- **`--approve` runs pi with per-action approvals off** on the host. Acceptable
  inside Gary's already-isolated per-ticket worktree; do not widen its cwd scope.
- **Single provider dependency** (openai-codex). GLM fallback is the mitigation;
  keep it working, don't let it bit-rot.

## Out of scope / open

- Bridging Gary's Linear/GitHub mutation tools into pi via MCP (revisit only if
  coding runs actually need mid-run ticket mutations).
- Migrating classification/nudges to pi (deliberately not doing this).
