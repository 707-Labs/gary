# Gary audit repair validation

Prepared against `a4d4e3a590655d4b66de7695223e59953d7200cc` in an isolated checkout; validation updated 2026-10-07 before the authorized deployment. Both synthetic DeepSeek fixtures passed through approved host networking, using four completed model calls. One earlier sandbox request failed without a response and remains reserved separately. On 7 October at 04:14 UTC, the user authorized starting Colima, fixing review failure policy, and deploying the validated repair.

## Behavioral changes

- `actions.outcome` records coding delivery separately from `success`. Existing success/idempotency/revisit behavior is preserved; old rows remain `unknown`, not retroactively labeled delivered. The migration is additive and idempotent and preserves unrelated columns.
- `report_blocked({reason})` terminates the agent without satisfying the check gate. Coding, check repair, and reviewer repair escalate blocked work before any publication. Prompts consistently distinguish blocked work from verified completion.
- Compaction reports the file paths whose contents it removed, and the loop invalidates those read-cache entries. Shell commands also invalidate cached reads because partial writes can occur even when a command fails.
- One existing `AGENT_LOOP_TIMEOUT_MS` allowance now covers CODE setup, primary work, checks, repairs, review, and PR-text generation. Child stages can shorten the absolute deadline, never renew it. The default stays 15 minutes; iteration and token settings were not raised.
- Model calls receive cancellation and remaining request time. Budgeted calls disable the installed SDK's hidden retry sleeps; provider fallback remains inside the shared deadline. Unbudgeted callers retain SDK retry defaults.
- Git and executor subprocess groups are stopped and awaited on cancellation. Docker client cancellation is followed by awaited named-container removal, with a separate five-second cleanup allowance and explicit error logging if removal fails.
- Late model output cannot invoke tools or claim completion. Adapter tool boundaries prevent follow-up requests after expiry; workflow-state mutation also checks after its state lookup.
- If an already-started PR creation returns after the deadline, its real PR identity is recorded and the outcome remains `pr_opened`; no further Linear write is started. Linear metadata failure after successful PR creation is logged instead of falsifying the delivery result.
- Two failed review attempts now escalate as `review_failed` with failure class `review_unavailable`, preserving both failure reasons and marking the round escalated. No approval is fabricated, no additional coding fixup is started, and publication stops. A valid retry approval can proceed only within the shared deadline.

Delivery reporting should query `outcome='pr_opened'`, not `success=1`. Non-coding normal dispatch is `handled`; thrown failures and provider exhaustion have distinct outcomes. No historical delivery claims are inferred.

## Offline verification

Run from the isolated checkout, which has no copied `.env` files:

```sh
bun run typecheck
env -u GARY_DOCKER_TEST_IMAGE bun test
git diff --check
```

The regression suite exercises historical-schema migration, duplicate suppression, blocked exits with existing commits, blocked check/review repairs, one shared deadline through all coding stages, late PR reconciliation, compaction followed by rereading, SDK cancellation/fallback, late model responses, process-group termination, Git lock-queue expiry, and fake Docker cleanup. Model transports/adapters are mocked; subprocess tests use disposable local fixtures.

Real Docker tests are explicitly opt-in. Their setup now does nothing when the image variable is absent, avoiding the previous attempt to create a directory under the live default Gary workspace even for skipped tests.

Final predeployment verification: **436 tests passed, 0 failed, 0 skipped, 1,053 assertions across 49 files** with the Docker tests enabled. TypeScript and diff checks passed. Review regressions cover failed/failed, failed/approved, failed re-review after a fixup, expiration before retry, and late retry approval preventing publication.

## Real Docker validation — passed

The original attempt on 6 October was blocked by stopped Colima. After explicit authorization, the existing VM started successfully on 7 October at 04:16 UTC with its existing configuration. The local `gary-executor:ubuntu24.04` image is `sha256:93af6b1a69bd234f42e87f6e702a031a050dffb4ac22c5ca804fa6ced7af6d42` (`linux/arm64`). No image was built or pulled and no mount/security policy was broadened.

The first container attempt failed because the Codex workspace is outside Colima's configured shared mounts. The successful test run used a newly created disposable directory within the existing `/Users/tanner/.gary/workspaces` mount; existing ticket workspaces were untouched. All **four real checks passed**: file/shell tools without host credentials; network and filesystem isolation; read-only worktree; and a live timed-out container removed before the executor returned. No test containers remained afterward. These checks also passed within the full suite.

The harness requires positive startup, fail-fast credential assertions, specific write-denial errors, local-only interface/route inspection, awaited asynchronous boundary rejection, and bounded test deadlines. Set `GARY_WORKSPACES_DIR` to an existing Colima-shared directory; tests create and remove only their own temporary child. Set `GARY_DOCKER_TEST_IMAGE` explicitly; the executor uses `--pull=never`.

## Approved synthetic validation — passed

On 2026-10-07 the user approved a $50 aggregate ceiling; the parent allocated at most $5 to Gary and authorized this narrower $0.25 reservation. Colima and deployment were subsequently authorized separately. No real external coding tasks were submitted as validation.

Implemented `scripts/validate-synthetic-deepseek.ts`. It uses the patched production loop and GLM adapter with one explicitly configured DeepSeek provider, an in-memory executor, no external adapters, and only five allowed tools. The fake shell accepts only `fixture-check`. The transport checks the exact destination/model, disables redirects and SDK retries, caps each fixture at three requests and 90 seconds, persists reservations before forwarding, and stops the whole batch on failure. It reads only the DeepSeek credential from the existing environment/config files, never includes credentials in model input/evidence, and disables SDK debug logging.

Typecheck and the offline transport self-test passed: the synthetic success path finished in three mock calls, and the unavailable-dependency path returned blocked in two. A separate read-only review found no blocking harness issue. These are offline results, not successful paid fixtures.

At **2026-10-07 01:04:54 UTC**, the first paid fixture attempted one request and returned `Connection error.` in 13 milliseconds, before any tool action. No HTTP response, usage receipt, or model output was received. The second fixture was not run, and no automatic retry/fallback occurred. A subsequent unauthenticated connection diagnostic failed with `curl: (6) Could not resolve host: api.deepseek.com`.

The parent explicitly authorized diagnosing sandbox versus host DNS and retrying via ordinary approved network escalation. In the sandbox, `socket.getaddrinfo` failed with errno 8 and `scutil --dns` reported no DNS configuration. A credential-free HEAD request to the exact same HTTPS API endpoint through the approved escalation returned **HTTP 401 in 0.249 seconds** at 01:06:59 UTC. This established a sandbox network restriction, not a host DNS outage. No DNS/security setting, endpoint, provider, or host override was changed. No automatic approval rejection occurred.

The retry harness imports and preserves the original ledger, takes an exclusive resume claim to prevent duplicate reuse, and rejects resume-of-resume. Global and per-fixture request counts include the failed attempt, leaving two new requests for success and three for blocked. The prior 13 milliseconds are deducted from the success fixture's 90-second allowance. The updated offline resume test and typecheck passed, and a separate read-only review verified the cumulative guards.

The authorized retry ran **01:08:45–01:08:53 UTC** via the approved network route:

| Fixture | Result | New model calls | Elapsed | Evidence |
| --- | --- | --- | --- | --- |
| Synthetic completion | Passed, `finished` | 2 | 3.722 s | Wrote `export const value = 42;`, fake check exited 0, then called `finish` |
| Unavailable dependency | Passed, `blocked` | 2 | 4.755 s | Fake check exited 1; `report_blocked` cited the unavailable dependency and prohibition on installation |

There were **five cumulative request attempts**, including the initial unknown attempt, and four HTTP 200 model responses. Reported usage totals 1,932 uncached input tokens, 2,048 cached input tokens, and 610 output tokens. Charging all input at the conservative uncached peak rate gives **$0.0076692** for accounted responses; this is a usage-based estimate, not an invoice. The original **$0.0301092** unknown reservation remains intact. Total reservations are **$0.150546**, below $0.25; no unused reservation was refunded or used to run more tests.

Evidence: `../gary-synthetic-paid-validation-resumed.json` is the cumulative ledger; `../gary-synthetic-paid-validation.json` preserves the initial failed attempt. Offline evidence is in `../gary-synthetic-self-test.json` and `../gary-synthetic-resume-self-test.json`. These fixtures validate the patched loop's completion/blocker behavior with the real provider and synthetic tools. They do not establish Docker behavior, live repository delivery, or paid-provider timeout cancellation.

Approved scope and accounting assumptions:

- Provider: only `deepseek-v4-pro` at the already approved `https://api.deepseek.com/anthropic` route. No fallback provider and no hidden retries.
- Data: two synthetic toy-code fixtures and the proposed completion/blocker instructions. No production repository contents, ticket descriptions, operational history, database data, or tool credentials are included in model-visible input.
- Scope: two agent-loop fixtures using an in-memory executor and fake adapters. Fixture A completes a tiny known change, passes a fake check, and calls `finish`. Fixture B receives a deterministic unavailable-dependency error and must call `report_blocked`. Tools cannot reach production services or execute host commands.
- Bounds: one run per fixture, at most three model requests per fixture, 2,048 output tokens per request, a 90-second deadline per fixture, no automatic rerun. Stop on unexpected tool behavior, nontermination, missing usage accounting, or insufficient remaining spend reservation. Compaction and process cancellation remain offline regressions; they do not justify longer paid loops.
- Cost estimate: official peak, uncached rates rechecked on 2026-10-07 are $1.32 per million input tokens and $3.96 per million output tokens. Each request reserves 16,666 input tokens and 2,048 output tokens. The harness requires serialized UTF-8 request bytes plus 4,096 framing allowance to fit the input reservation and checks returned usage; this is a conservative token estimate, not a provider-enforced tokenizer limit. Reservations are never refunded on an unknown outcome. No pricing or spend estimate is a guarantee against provider billing behavior.

Pricing source: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/). No cache or off-peak discount is assumed.

## Deployment prerequisites and remaining limits

1. Commit only the reviewed repair files and publish the exact tested revision. The isolated checkout's origin points to the local source repository; it is not the deployment remote. Verify the canonical checkout remains clean and remote/main equals the intended release.
2. Recheck idle immediately before stopping Gary. Stop the old process before changing source; the canonical script itself pulls before stopping and does not provide an explicit clean-tree guard.
3. Take a consistent SQLite backup using SQLite's backup API, not a bare copy of a live WAL database. Save the prior source revision and installed plist. Validate the backup with `quick_check`.
4. Use the canonical local deployment script only after remote/main is pinned to the intended release. Startup adds `actions.outcome`. Roll back code/plist if verification fails, retaining the latest database: old code tolerates the additive column, and restoring stale operational state could replay actions.
5. Verify the new boot, fresh polling, additive schema, and explicit outcomes. Initially supervise the smaller shared 15-minute allowance; it no longer silently renews for repair loops. Do not raise it just to hide persistent blockers.

Known limits: legacy GitHub/Linear/Cloudflare SDK requests already in flight are not universally cancellable. The deadline prevents subsequent work where guarded, but cannot retract an accepted remote mutation. Timeout escalation/bookkeeping is deliberately allowed after the execution budget. Interrupted Git rebases can leave recoverable rebase state; no new cleanup mutation begins after deadline. Docker cleanup failure is logged; actual timeout removal passed against this daemon. Paid-provider timeout cancellation remains unverified; the successful synthetic fixtures do not exercise that path.

Classifier truncation handling, dependency-readiness admission, and stronger read-only reviewer/subagent isolation remain separate audit findings, not claimed fixed here. The repaired review policy makes an unavailable review block publication; it does not establish those broader execution boundaries.
