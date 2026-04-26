# Multi-repo / multi-team support

**Status:** Approved for implementation
**Date:** 2026-04-25

## Goal

Let Gary handle Linear tickets from multiple teams and open PRs against the
matching repository. Concretely, expand from `707-Labs/ertai` (`ERT`) to also
cover `707-Labs/birdup` (`BIRD`) and `707-Labs/green-ledger` (`GREEN`).

## Non-goals

- Per-repo CI commands, executors, or secrets. All three repos share Gary's
  current pipeline (bun, GitHub App, agent loop, Cloudflare obs).
- Per-installation GitHub App tokens. All target repos live in the `707-Labs`
  org, so the existing `GITHUB_APP_INSTALLATION_ID` continues to cover them.
- Cross-org support. Out of scope until a non-707-Labs target appears.
- Repo-specific Cloudflare observability scoping. Workers and D1 databases
  remain a flat global list; agents disambiguate by worker/database name.

## Design

### Configuration

Replace the current single-repo env var:

```
# before
GARY_ALLOWED_REPOS=707-Labs/ertai
```

with a team-key → repo map:

```
# after
GARY_REPO_MAP=ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup
```

Format rules:

- Comma-separated entries.
- Each entry is `<TEAM_KEY>:<owner>/<repo>`.
- Team keys must be unique (loader rejects duplicates).
- Empty value disables Gary's coding pipeline entirely (same as missing today).

`src/config.ts` parses this into a `ReadonlyMap<string, string>` exposed as
`runtime.repoMap`. The loader fails fast on malformed entries with a clear
error message naming the bad row.

### Dispatch

`src/loop.ts:678` currently has:

```typescript
if (!deps.allowedRepos.includes(`${issue.teamKey === "ERT" ? "707-Labs/ertai" : ""}`)) {
  if (deps.allowedRepos.length === 1 && deps.allowedRepos[0]) {
    // fall through, use first
  } else {
    throw new Error(`cannot map team ${issue.teamKey} to a repo; ...`);
  }
}
const repo = deps.allowedRepos[0];
```

Replace with:

```typescript
const repo = deps.repoMap.get(issue.teamKey);
if (!repo) {
  log.info("skipping ticket: no repo mapping for team", {
    issue: issue.identifier,
    teamKey: issue.teamKey,
  });
  return;
}
```

Behavior change: tickets from unmapped teams are **skipped silently** with a
log line, rather than throwing. This matches the de-facto behavior today
(only-allowed-repo fallback masked the missing mapping) and avoids spurious
escalations when a teammate accidentally assigns Gary a ticket from a team
he isn't wired up for.

### Wiring

- `src/index.ts` passes `repoMap` instead of `allowedRepos` to `runLoop`.
- `LoopDeps` type drops `allowedRepos`, gains `repoMap: ReadonlyMap<string, string>`.
- Probe scripts that constructed loops (`scripts/probe-loop-tick.ts`) get
  the same swap.

### Observability and D1

No code change. Operationally, expand the existing flat lists:

```
CLOUDFLARE_OBSERVABILITY_WORKERS=mulligan-labs,mulligan-labs-party,mulligan-labs-feedback,mulligan-labs-discord-bot,birdup,green-ledger
CLOUDFLARE_D1_DATABASES=mulligan-labs=<uuid>,birdup=<uuid>,green-ledger=<uuid>
```

The agent passes `service` / `database` as a free-form parameter to the tools
and the adapter scopes the request accordingly. Worker names are
project-prefixed in practice, so the agent disambiguates from context.

## Tests

- `test/config.test.ts` (extend or add):
  - parses a valid `GARY_REPO_MAP` into the expected map
  - rejects duplicate team keys with a useful error
  - rejects malformed entries (`foo`, `:bar`, `ERT:`)
  - empty / unset returns an empty map
- `test/loop.test.ts` or a new `test/loop-multirepo.test.ts`:
  - ticket from a mapped team dispatches against the mapped repo
  - ticket from an unmapped team is skipped (no throw, no PR)
  - existing single-repo behavior still works when the map has one entry

## Migration

The mini currently runs with `GARY_ALLOWED_REPOS=707-Labs/ertai`. Migration
steps after merge:

1. SSH to the mini.
2. Edit `~/.gary/.env` (or wherever Gary's env is sourced from): comment out
   `GARY_ALLOWED_REPOS`, add `GARY_REPO_MAP=ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup`.
3. Run `bun run deploy` (which pulls, typechecks, reloads launchd).
4. Verify with `bun run logs` that the next tick parses the map and processes
   any pending tickets correctly.

Pre-requisites on Tanner's side (out of band):
- Confirm the Gary GitHub App is installed on `707-Labs/birdup` and
  `707-Labs/green-ledger`. If not, add them to the existing installation.
- Confirm the Linear teams `BIRD` and `GREEN` exist with those exact keys.

## Risks

- **Unmapped-team silent skip can hide real misconfiguration.** Mitigation:
  log at `info` with `teamKey` so it shows up in `bun run logs`. If this
  becomes noisy in practice, escalate to a one-shot Linear comment ("can't
  map team X — please add to GARY_REPO_MAP").
- **Missing GitHub App install on a new repo.** Pushes will 404 with an
  unhelpful error. Mitigation: deploy script could probe each repo's
  installation at startup. Out of scope for this change; revisit if it bites.
- **Backwards-incompat env-var rename.** Mitigation: deploy script changes
  on the mini happen at the same commit as the code change; no overlap
  window where one side is misconfigured.
