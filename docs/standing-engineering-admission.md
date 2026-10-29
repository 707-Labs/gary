# Ordinary DM engineering admission

This offline implementation replaces the one-task acceptance constraint with a
standing-policy admission path. It is disabled unless a separately pinned host
configuration, standing authority receipt, and explicitly funded coding pool are
all present. Startup never enrolls funds. Historical acceptance and conversation
allocations remain separate.

An authenticated Tanner DM such as “Fix the broken parser in
707-Labs/example and add a regression test” can offer `engineering_submit` to the
conversation. The model supplies only a repository name. A host capability binds
the original message, sender, workspace, DM, event, and destination. Quoted,
negated, deferred, or ambiguous instructions cannot create a task. Ambiguous
repository or timing needs clarification in Slack, not an operator grant.

The host resolves current access through the existing GitHub App and pins the
default branch's current commit. It creates an independent clone and derives a
verification profile from that pristine clone. Only then does it allocate a new
task ceiling from the distinct standing pool. No issue enrollment, ERT-3434
activation, preselected repository, or two-file acceptance grant participates in
the new task decision.

Each original Slack message can admit at most one task. Admission is durable;
redelivery cannot rerun it. The worker starts only after a successfully committed
conversation answer is delivered and all conversation workers have drained.
Known clean conversation failures cancel only the still-unstarted task; uncertain
delivery or cleanup preserves the stop. A process restart never silently adopts
an old worker or replays a stopped task.

Repository source scope includes relevant new and deleted files, with a bounded
512-file / 2 MiB capture. Credential paths, host state and Git metadata cannot
enter the artifact. The host captures a pristine baseline before execution,
closes the author, imports exact source into a fresh clone of the same base, runs
the required checks, closes the verifier, rechecks the complete source inventory,
and obtains a separate model review. Branch advancement during work does not
change the verifier's pinned base.

## Funding configuration

One explicit ongoing coding allocation is missing. The necessary decision is a
finite standing pool amount, a per-task ceiling, and its funding source (an
explicit additional amount or a separately authorized reconciliation/reallocation).
For example, a $20 pool with a $5 task ceiling permits four automatically admitted
tasks under the initial conservative accounting policy. This example is not an
approval or an enrollment.

The minimum task ceiling is $2.816878: one maximum work reservation plus the
protected independent-review reservation. The request ceiling is twelve work
requests plus one review; settled actual charges determine whether further
requests fit. Unknown attempts keep their full charge and stop the task.

The canonical spend ledger records a dedicated standing campaign and immutable
request/task allocations. Task ceilings are committed conservatively and are not
automatically recycled after completion. This is an allocation limit as well as a
dollar limit; exhausted commitments are reported separately from actual charges.

`createStandingEngineeringFundingGuard` validates hash-pinned approval and hold
receipts against the aggregate ledger before enrollment, admission, and model
requests. A finite additional runtime amount must be explicit in the funding
receipt. Existing acceptance funds, conversation funds, unknown holds, the $40
reserved outside the runtime pool, and the $3 Commonfield earmark cannot be
silently reassigned.

After approval and reviewed activation preparation, the operator records the
distinct aggregate hold and calls `createStandingEngineeringBudget(...).enrollPool()`
once. Normal Slack requests subsequently allocate task ceilings automatically.
The loader and allocator are inert with respect to external work until invoked;
the application startup only observes existing enrollment.

The host configuration uses four new pins:

- `GARY_STANDING_ENGINEERING_CONFIG`
- `GARY_STANDING_ENGINEERING_CONFIG_SHA256`
- `GARY_STANDING_ENGINEERING_AUTHORITY`
- `GARY_STANDING_ENGINEERING_AUTHORITY_SHA256`

The standing and acceptance runtime configurations are mutually exclusive. The
standing configuration schema is in `standing-engineering-config.ts`; it binds
the reviewed release, private state/workspace roots, existing App scope, runtime
files, immutable images, cache, physical resource lock identity, and funding
receipt paths. It must be reviewed with the concrete funding records before
activation. No deployment is part of this offline change.

## Optional routine engineering profile

A separately pinned `routine` configuration composes the native engineering
capabilities. Omitting it preserves the five-tool, thirty-minute configuration.
The routine profile admits fourteen native tools: terminal, read_file,
write_file, patch, search_files, process, execute_code, memory, session_search,
todo, skills_list, skill_view, skill_manage, and delegate_task. The schema pin is
`299764771687acb7c2434847d2e57ef4181d4473cac5da4bfdeb8b3588954b59`.
Its private scoped root, integrity-key path and key hash must be configured
separately from workspaces. Startup opens the scoped store only after funding
enrollment is verified.

Routine tasks use their original persisted start time and a deadline of at most
150 minutes. Restart cannot renew this window. The aggregate resource lease is
4 CPU / 8 GiB; each sandbox has a smaller explicit limit. One parent can run at
most two serial, one-level delegated workers with separate clones and homes.
Their model work and skill evaluation consume the parent's twelve work requests,
task allocation and deadline; the final independent review remains reserved.
Children return bounded source captures for the parent to integrate. They cannot
publish or promote their own skills.

Native memory, closed session databases and canonical history persist under an
exact workspace, audience and immutable repository-ID scope. Draft skills resume
only within the same task. Documentation-only skill promotion requires metered
evaluation and a separate review with settled receipts. Executable drafts remain
unpromoted without a sandbox evaluator. Checkpointing requires confirmed absence
of all native and build writers. Unknown cleanup retains resource custody and
open state handles; startup shutdown cannot report a clean drain.

Host-mediated dependency downloads support canonical public npm coordinates from
pristine npm v2/v3 locks or Bun text v1 locks. Before writers start, the host mints
an admission bound to the baseline name, version and integrity tuples. Candidate
profiles may change supported package inputs but cannot introduce new tuples.
The broker validates public DNS, redirects, integrity, bytes, request counts and
the shared deadline, with no caller headers or credentials. Workers consume an
immutable read-only bundle and install within their network-disabled sandbox.
Lifecycle scripts require the explicit routine configuration flag and run only
inside that sandbox. Actual image and installer parity still requires validation.

## Current implementation limits

- Production admission is Tanner's authenticated private DM and one repository
  per task. Source and persistence are bound to the GitHub App's immutable
  repository ID. Shared-channel, multi-repository and paused-task adoption paths
  are not enabled.
- Supported verification remains Bun/npm JavaScript projects with meaningful
  noninteractive scripts. New dependency coordinate resolution, other
  toolchains and a general documentation broker are not provided.
- The native tool adapters, cleanup protocol and installer have offline unit and
  mocked integration coverage. Those checks do not prove execution against the
  concrete native image or a paid provider.
- Production output remains a verified local patch. The tested host publication
  adapter supports draft PR creation and guarded successor updates, plus linked
  ticket results. Runtime publication admission, concrete CI funding and runner
  authority are still required before it can be connected for remote writes.
- Source proposals in Gary's isolated clone do not modify or deploy the live
  service. The ordinary coding pool is a separate approval and enrollment; no
  activation or enrollment is part of this offline change.

These limits must remain visible in rollout claims. Passing the offline suite
does not establish a paid native acceptance, a live deployment, or full Hermes
enablement.

## Reboots and deploys

The resource lock `/private/tmp/apple-release-xcode.lock` is pinned by identity
(dev/ino) together with the boot session it was observed in. macOS empties
`/private/tmp` at boot. On the first standing start in a new boot,
`resolveEngineeringResourceLockForBoot` mints a new pin only after
`assertEngineeringRebootQuiescent` shows every engineering task terminal with
confirmed cleanup, every ingress request and runtime run closed, no reserved or
unknown spend attempt on any standing allocation, and no container carrying
`gary.task` or `dev.gary.executor-job`. It creates the lock (0644, never
replacing or fixing an existing file) and records the pin once in
`<root>/resource-boot-bindings/<bootSessionUUID>.json`. Later starts in the
same boot reuse that receipt, so replacing the lock within a boot still fails.
A different APFS volume is never re-bound. The config file is never edited.

`scripts/deploy.sh` re-applies the four standing pins from the private file
`~/.gary/runtime/standing-engineering.env` (0600, `KEY=value` lines). It refuses
to deploy if either pinned file no longer matches its hash or if the standing
config's `sourceRevision` is not the release being deployed. Move the file aside
to deploy with standing engineering disabled.

## Relocating a standing grant's aggregate

`scripts/relocate-standing-funding.ts` moves a standing grant to a new aggregate
by transfer: the old aggregate is copied byte-for-byte, the old standing hold is
retired in the copy at exactly its committed amount, and the rest funds a new
hold. Nothing in the old file is edited. `--apply` also writes
`<old aggregate>.admission.lock/transferred.json`; the standing funding guard
refuses any grant whose aggregate has that file. `--enroll` retires the old pool
in `standing_engineering_pool_retirements` and enrolls the new pool in one
spend-ledger transaction; a retired pool can never allocate, converse or spend.
Both refuse while the LaunchAgent has a running process.

Relocation refuses while the old aggregate holds an acceptance or readonly-canary
allocation, because those are reconciled by code that writes the old path.
Other held entries are copied verbatim.

The approval evidence is a 0600 JSON file with exactly these keys:

```json
{
  "version": 1,
  "kind": "standing_engineering_relocation_approval",
  "approver": "Tanner Vass",
  "approvedAt": "2026-10-28",
  "approvalText": "<verbatim approval>",
  "sourceHoldId": "standing-engineering:<old pool id>",
  "retiredPoolId": "<old pool id>",
  "transferredMicros": 16305670,
  "newPoolId": "<new pool id>"
}
```

The dry run prints this template with the exact ids and amount filled in.
