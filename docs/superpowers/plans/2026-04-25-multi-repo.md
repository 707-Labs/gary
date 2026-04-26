# Multi-repo / multi-team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-repo `GARY_ALLOWED_REPOS` env var with a teamKey → repo map (`GARY_REPO_MAP`) so Gary can handle Linear tickets from multiple teams (`ERT`, `BIRD`, `GREEN`) and open PRs against the matching `707-Labs` repository.

**Architecture:** Introduce a pure `parseRepoMap` helper in `src/config.ts` that returns a `ReadonlyMap<string, string>`. Replace three dispatch sites in `src/loop.ts` (`runStartCoding`, `runWriteAnswer`, `derivePr`) with `repoMap.get(teamKey)` lookups. Update wiring through `src/index.ts` and probe scripts. Cloudflare observability and D1 stay flat global lists; only the map config and dispatch change.

**Tech Stack:** Bun, TypeScript, zod (already used in config), bun:test, bun:sqlite (unchanged).

**Spec:** `docs/superpowers/specs/2026-04-25-multi-repo-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Export `parseRepoMap`. Replace `allowedRepos` field with `repoMap` on `GaryConfig`. |
| `src/loop.ts` | Modify | Replace `LoopDeps.allowedRepos` with `repoMap`. Update three lookup sites. |
| `src/index.ts` | Modify | Pass `repoMap` to `runLoop`; update boot log. |
| `scripts/probe-loop-tick.ts` | Modify | Pass `repoMap` to loop deps. |
| `scripts/probe-github.ts` | Modify | Iterate `repoMap.values()` instead of indexing `allowedRepos[0]`. |
| `scripts/probe-github-raw.ts` | Modify | Same. |
| `scripts/rewrite-pr-style.ts` | Modify | Same. |
| `test/config.test.ts` | Create | Unit tests for `parseRepoMap`. |
| `.env.example` | Modify | Replace `GARY_ALLOWED_REPOS` doc with `GARY_REPO_MAP`. |
| `CLAUDE.md` | Modify | Update env-var section to reference `GARY_REPO_MAP`. |

---

## Task 1: Extract and test `parseRepoMap`

**Files:**
- Create: `test/config.test.ts`
- Modify: `src/config.ts:38-41` (replace `reposSchema`) and `src/config.ts:43-57` (`GaryConfig` interface) and `src/config.ts:132-133` (parse call)

- [ ] **Step 1: Write the failing test file**

Create `test/config.test.ts` with these contents:

```typescript
import { describe, expect, it } from "bun:test";
import { parseRepoMap } from "../src/config.ts";

describe("parseRepoMap", () => {
  it("parses a single entry", () => {
    const map = parseRepoMap("ERT:707-Labs/ertai");
    expect(map.size).toBe(1);
    expect(map.get("ERT")).toBe("707-Labs/ertai");
  });

  it("parses multiple comma-separated entries", () => {
    const map = parseRepoMap(
      "ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup",
    );
    expect(map.size).toBe(3);
    expect(map.get("ERT")).toBe("707-Labs/ertai");
    expect(map.get("GREEN")).toBe("707-Labs/green-ledger");
    expect(map.get("BIRD")).toBe("707-Labs/birdup");
  });

  it("trims whitespace around entries and components", () => {
    const map = parseRepoMap(" ERT : 707-Labs/ertai , GREEN : 707-Labs/green-ledger ");
    expect(map.get("ERT")).toBe("707-Labs/ertai");
    expect(map.get("GREEN")).toBe("707-Labs/green-ledger");
  });

  it("returns an empty map for an empty string", () => {
    expect(parseRepoMap("").size).toBe(0);
  });

  it("rejects duplicate team keys", () => {
    expect(() =>
      parseRepoMap("ERT:707-Labs/ertai,ERT:707-Labs/other"),
    ).toThrow(/duplicate team key/i);
  });

  it("rejects malformed entries missing the colon", () => {
    expect(() => parseRepoMap("707-Labs/ertai")).toThrow(/expected/i);
  });

  it("rejects entries with empty team key", () => {
    expect(() => parseRepoMap(":707-Labs/ertai")).toThrow();
  });

  it("rejects entries with empty repo", () => {
    expect(() => parseRepoMap("ERT:")).toThrow();
  });

  it("rejects entries with bad repo shape", () => {
    expect(() => parseRepoMap("ERT:not-a-repo")).toThrow(/owner\/repo/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL with "Export named 'parseRepoMap' not found in module".

- [ ] **Step 3: Add `parseRepoMap` export and replace `reposSchema` in `src/config.ts`**

Replace lines 38-41 (`reposSchema`) with:

```typescript
const REPO_SHAPE = /^[^/]+\/[^/]+$/;

export function parseRepoMap(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return map;
  for (const entry of trimmed.split(",")) {
    const cleaned = entry.trim();
    if (cleaned.length === 0) continue;
    const colonAt = cleaned.indexOf(":");
    if (colonAt < 0) {
      throw new Error(
        `GARY_REPO_MAP entry "${cleaned}" expected "<TEAM_KEY>:<owner>/<repo>"`,
      );
    }
    const teamKey = cleaned.slice(0, colonAt).trim();
    const repo = cleaned.slice(colonAt + 1).trim();
    if (teamKey.length === 0) {
      throw new Error(`GARY_REPO_MAP entry "${cleaned}" has empty team key`);
    }
    if (repo.length === 0) {
      throw new Error(`GARY_REPO_MAP entry "${cleaned}" has empty repo`);
    }
    if (!REPO_SHAPE.test(repo)) {
      throw new Error(
        `GARY_REPO_MAP entry "${cleaned}" repo must be owner/repo, got "${repo}"`,
      );
    }
    if (map.has(teamKey)) {
      throw new Error(
        `GARY_REPO_MAP duplicate team key "${teamKey}"`,
      );
    }
    map.set(teamKey, repo);
  }
  return map;
}
```

Update `GaryConfig` (replace `allowedRepos: readonly string[]` at line 51 with):

```typescript
  /** Linear team key → "owner/repo". Empty map disables the coding pipeline. */
  repoMap: ReadonlyMap<string, string>;
```

Update `loadGaryConfig` (replace lines 132-133 and the return-object `allowedRepos` at line 149 with):

```typescript
  const repoMap = parseRepoMap(
    stringFromEnv("GARY_REPO_MAP", "ERT:707-Labs/ertai"),
  );
```

```typescript
    repoMap,
```

(Default value preserves single-repo behavior for any test or probe that doesn't override it.)

- [ ] **Step 4: Run config tests to verify pass**

Run: `bun test test/config.test.ts`
Expected: PASS, 9 tests green.

- [ ] **Step 5: Run typecheck (rest of codebase will fail; that's expected)**

Run: `bun run typecheck`
Expected: FAIL with errors in `src/loop.ts`, `src/index.ts`, and the probe scripts referencing `allowedRepos`. We fix those next.

- [ ] **Step 6: Do NOT commit yet**

Holding the commit until Task 2 lands so the tree only has one half-broken intermediate. Move to Task 2.

---

## Task 2: Replace dispatch sites in `src/loop.ts`

**Files:**
- Modify: `src/loop.ts:62` (LoopDeps), `src/loop.ts:618-620` (`runWriteAnswer`), `src/loop.ts:678-690` (`runStartCoding`), `src/loop.ts:794` (`derivePr`)

- [ ] **Step 1: Update `LoopDeps` (line 62)**

Replace:

```typescript
  allowedRepos: readonly string[];
```

with:

```typescript
  repoMap: ReadonlyMap<string, string>;
```

- [ ] **Step 2: Replace `runStartCoding` dispatch (lines 678-690)**

Replace the entire current block:

```typescript
  if (!deps.allowedRepos.includes(`${issue.teamKey === "ERT" ? "707-Labs/ertai" : ""}`)) {
    // Weekend 1 only handles Ertai. Map team → repo. If the team isn't
    // mapped, escalate.
    if (deps.allowedRepos.length === 1 && deps.allowedRepos[0]) {
      // Single allowed repo — assume that's the target.
    } else {
      throw new Error(
        `cannot map team ${issue.teamKey} to a repo; allowed repos: ${deps.allowedRepos.join(", ")}`,
      );
    }
  }
  const repo = deps.allowedRepos[0];
  if (!repo) {
    throw new Error("no allowed repos configured");
  }
```

with:

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

- [ ] **Step 3: Replace `runWriteAnswer` repo lookup (lines 618-620)**

Replace:

```typescript
  const repo = deps.allowedRepos[0];
  if (!repo) throw new Error("no allowed repos configured");
```

with:

```typescript
  const repo = deps.repoMap.get(issue.teamKey);
  if (!repo) {
    log.info("skipping answer: no repo mapping for team", {
      issue: issue.identifier,
      teamKey: issue.teamKey,
    });
    return;
  }
```

- [ ] **Step 4: Replace `derivePr` filter (line 794)**

Replace:

```typescript
  if (!deps.allowedRepos.includes(row.repo)) return null;
```

with:

```typescript
  const mappedRepos = new Set(deps.repoMap.values());
  if (!mappedRepos.has(row.repo)) return null;
```

- [ ] **Step 5: Hold off running tests; index/probes still reference `allowedRepos`**

Move directly to Task 3 to clean up the rest of the wiring before validating.

---

## Task 3: Update wiring (index, probes) and validate

**Files:**
- Modify: `src/index.ts:37` (boot log) and `src/index.ts:55` (runLoop call)
- Modify: `scripts/probe-loop-tick.ts:33`
- Modify: `scripts/probe-github.ts:13,18`
- Modify: `scripts/probe-github-raw.ts:30`
- Modify: `scripts/rewrite-pr-style.ts:28`

- [ ] **Step 1: `src/index.ts` boot log (line 37)**

Replace:

```typescript
    allowedRepos: cfg.gary.allowedRepos,
```

with:

```typescript
    repoMap: Object.fromEntries(cfg.gary.repoMap),
```

(Logger renders objects fine — see `pollIntervalMs` neighbour.)

- [ ] **Step 2: `src/index.ts` runLoop call (line 55)**

Replace:

```typescript
    allowedRepos: cfg.gary.allowedRepos,
```

with:

```typescript
    repoMap: cfg.gary.repoMap,
```

- [ ] **Step 3: `scripts/probe-loop-tick.ts` (line 33)**

Replace:

```typescript
  allowedRepos: cfg.gary.allowedRepos,
```

with:

```typescript
  repoMap: cfg.gary.repoMap,
```

- [ ] **Step 4: `scripts/probe-github.ts` (lines 13, 18)**

Replace the existing `if`/`const target` block (around lines 13-18):

```typescript
if (gary.allowedRepos.length === 0) {
  console.error("No GARY_ALLOWED_REPOS configured");
  process.exit(1);
}
const target = gary.allowedRepos[0]!;
```

with:

```typescript
if (gary.repoMap.size === 0) {
  console.error("No GARY_REPO_MAP configured");
  process.exit(1);
}
const target = [...gary.repoMap.values()][0]!;
```

- [ ] **Step 5: `scripts/probe-github-raw.ts` (line 30)**

Replace:

```typescript
const target = gary.allowedRepos[0]!;
```

with:

```typescript
const target = [...gary.repoMap.values()][0]!;
```

(If a guard for empty map is missing here, add the same `if (gary.repoMap.size === 0)` block above as in Step 4. Check the surrounding context before editing.)

- [ ] **Step 6: `scripts/rewrite-pr-style.ts` (line 28)**

Replace:

```typescript
const repo = gary.allowedRepos[0];
```

with:

```typescript
const repo = [...gary.repoMap.values()][0];
```

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: PASS (all tests, including the new 9 in `test/config.test.ts`). Total should be the prior count + 9.

- [ ] **Step 9: Commit Tasks 1-3**

```bash
git add src/config.ts src/loop.ts src/index.ts scripts/probe-loop-tick.ts \
  scripts/probe-github.ts scripts/probe-github-raw.ts scripts/rewrite-pr-style.ts \
  test/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): GARY_REPO_MAP for multi-repo team dispatch

Replaces single-repo GARY_ALLOWED_REPOS with a teamKey -> "owner/repo"
map. runStartCoding, runWriteAnswer, and derivePr now look up the repo
by issue.teamKey via repoMap.get(); tickets from unmapped teams are
skipped silently with an info log.

Default map (ERT:707-Labs/ertai) preserves single-repo behavior when
the env var is unset. Adds parseRepoMap helper + 9 unit tests covering
single/multi entries, whitespace, duplicates, and malformed input.
EOF
)"
```

---

## Task 4: Update docs

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `.env.example`**

Replace the existing `GARY_ALLOWED_REPOS` block:

```
# Repos (Weekend 1: just Ertai)
GARY_ALLOWED_REPOS=707-Labs/ertai
```

with:

```
# Repo map: <TEAM_KEY>:<owner>/<repo>, comma-separated. Each Linear team
# Gary handles needs an entry here. Tickets from teams not in the map
# are skipped silently. All repos in the same GitHub org share one App
# installation.
GARY_REPO_MAP=ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup
```

- [ ] **Step 2: Update `CLAUDE.md` Environment section**

Find the Environment section's required-keys paragraph and replace any reference to `GARY_ALLOWED_REPOS` with `GARY_REPO_MAP`. The current paragraph mentions `GARY_ALLOWLISTED_MENTION_USER_IDS` near the end — leave that alone. Use grep first to locate the exact text:

Run: `grep -n "GARY_ALLOWED_REPOS\|allowed_repos\|ertai" /Users/tanner/Developer/gary/CLAUDE.md`

Replace any `GARY_ALLOWED_REPOS` mentions with `GARY_REPO_MAP`. If there's a sentence describing single-repo support, broaden it to: "Tickets are dispatched by Linear team key; `GARY_REPO_MAP=ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup` covers all three current targets."

- [ ] **Step 3: Run typecheck (sanity)**

Run: `bun run typecheck`
Expected: PASS (docs-only changes shouldn't affect this, but verify).

- [ ] **Step 4: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: update env-var docs for GARY_REPO_MAP"
```

---

## Task 5: Deploy and migrate the mini

These steps touch a remote machine. Don't combine them into the previous commit.

- [ ] **Step 1: Confirm local main is clean and ahead**

Run: `git status && git log --oneline -3`
Expected: Working tree clean, two new commits ahead of `5ae630d`.

- [ ] **Step 2: Push to origin**

Run: `git push origin main`
Expected: pushes 2 commits.

- [ ] **Step 3: Migrate the mini's env file**

SSH to the mini. The env file is `~/.gary/.env` (or wherever the LaunchAgent sources from — confirm via `launchctl print gui/$(id -u)/com.707labs.gary | grep -i env` if uncertain).

Edit it:
- Comment out the existing `GARY_ALLOWED_REPOS=707-Labs/ertai` line.
- Add: `GARY_REPO_MAP=ERT:707-Labs/ertai,GREEN:707-Labs/green-ledger,BIRD:707-Labs/birdup`

- [ ] **Step 4: Run deploy script**

Run: `bun run deploy`
Expected: pulls latest, installs, typechecks, reloads launchd. Script exits 0.

- [ ] **Step 5: Tail logs and verify boot**

Run: `bun run logs` (or tail `~/Library/Logs/gary/stdout.log` on the mini).
Expected: see "gary booted" log line containing `repoMap: { ERT: '707-Labs/ertai', GREEN: '707-Labs/green-ledger', BIRD: '707-Labs/birdup' }` (or similar serialization).

- [ ] **Step 6: Verify a tick processes correctly**

Wait one poll cycle (60s). Watch logs for a normal tick that lists assigned issues. Confirm no `cannot map team` errors. If a BIRD or GREEN ticket is in queue, confirm the dispatch path picks the right repo.

- [ ] **Step 7: Pre-requisite check (manual, on Tanner's side)**

Confirm the Gary GitHub App is installed on `707-Labs/birdup` and `707-Labs/green-ledger` (Settings → Integrations → GitHub Apps in the 707-Labs org). If not, install before assigning tickets to those teams. Also confirm Linear teams `BIRD` and `GREEN` exist with those exact keys.

---

## Self-Review

**Spec coverage:**
- Goal: replace `GARY_ALLOWED_REPOS` with `GARY_REPO_MAP` → Tasks 1, 4
- Loop dispatch using `repoMap.get(teamKey)` → Task 2 Steps 2-4
- Skip silently on unmapped teams → Task 2 Steps 2-3 (`log.info` + `return`)
- Single GitHub App installation continues to cover all repos → no change required (covered by absence of installation-resolution work)
- Cloudflare obs / D1 stay flat global lists → no change required (covered by absence of those tasks)
- Probe scripts swap `allowedRepos` → `repoMap` → Task 3 Steps 4-6
- `.env.example` and `CLAUDE.md` updates → Task 4
- Mini env-var migration → Task 5 Step 3

All spec sections covered.

**Placeholder scan:** No "TBD", "TODO", "etc.", "similar to". Each step shows the exact code or command needed.

**Type consistency:** `parseRepoMap` returns `ReadonlyMap<string, string>` in Task 1 Step 3, `GaryConfig.repoMap` matches in same step, `LoopDeps.repoMap` matches in Task 2 Step 1, all consumers use `.get()` or `.values()` consistently.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — I execute tasks in this session with checkpoints for review.

Which approach?
