# Reviewer Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fresh-agent reviewer pass between primary-agent finish and branch push to catch unverified fixes, half-wired features, and untested logic before they land as PRs.

**Architecture:** A new reviewer agent runs after `ensurePostFinishCheckPasses` and before rebase-and-push in `src/handlers/code.ts`. It uses a different LLM provider preference order, an adversarial bug-finding prompt, read+run+submit_review tools, and three deterministic pre-checks (untested exports, unwired identifiers, run-log absence). Verdict is `approve` or `changes_needed`; primary re-enters the fix loop on rejection up to 3 rounds, then escalates. Reviewer crashes default-approve after one retry. Verdict is persisted in a new `review_passes` table.

**Tech Stack:** Bun runtime, bun:sqlite, TypeScript strict, zod, Anthropic SDK. Same stack as the rest of Gary.

**Spec:** [`docs/superpowers/specs/2026-04-27-reviewer-pass-design.md`](../specs/2026-04-27-reviewer-pass-design.md)

---

## File Plan

**New files:**
- `src/review/precheck.ts` — pre-check functions over `{ diff, worktreePath, runLog }`
- `src/review/tools.ts` — reviewer toolset (read + run_bash + submit_review)
- `src/review/prompts.ts` — reviewer system + task prompts
- `src/review/runner.ts` — `runReviewer` orchestration (loop + retry + persistence)
- `src/state/review-queries.ts` — `recordReviewPass` and analytics helpers
- `test/review-precheck.test.ts`
- `test/review-tools.test.ts`
- `test/review-runner.test.ts`
- `test/review-queries.test.ts`

**Modified files:**
- `src/state/schema.sql` — add `review_passes` table
- `src/agent/loop.ts` — capture `RunLogEntry[]`, expose on result
- `src/agent/tools.ts` — `runBashTool` calls a callback to record run-log entries
- `src/providers.ts` — add `chainWithOrder` for arbitrary reorders
- `src/escalate.ts` — add `review_rejected` to `EscalationReason`
- `src/handlers/code.ts` — invoke reviewer between post-finish-check and push; embed verification report in PR body
- `src/config.ts` — load reviewer env vars
- `.env.example` — document new env vars
- `CLAUDE.md` — document reviewer, gotchas, env

---

## Task 1: Schema migration for `review_passes` table

**Files:**
- Modify: `src/state/schema.sql`
- Create: `src/state/review-queries.ts`
- Create: `test/review-queries.test.ts`

This task adds the persistence surface the reviewer will write to. Other tasks depend on the table and `recordReviewPass` existing.

- [ ] **Step 1: Write the failing test for `recordReviewPass`**

Create `test/review-queries.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordReviewPass, type ReviewPassInput } from "../src/state/review-queries.ts";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/state/schema.sql",
);

function freshDb(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query(
    "INSERT INTO tickets (linear_id, identifier) VALUES ('issue-1', 'ERT-1')",
  ).run();
  return db;
}

describe("recordReviewPass", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts a row with the expected fields", () => {
    const input: ReviewPassInput = {
      issueLinearId: "issue-1",
      fingerprint: "fp-abc",
      round: 1,
      verdict: "approve",
      findingCount: 0,
      advisoryCount: 2,
      providerUsed: "deepseek",
      inputTokens: 12_000,
      outputTokens: 800,
      durationMs: 4_500,
      escalated: false,
    };
    recordReviewPass(db, input);
    const row = db
      .query<{
        issue_id: string;
        verdict: string;
        provider_used: string | null;
        duration_ms: number;
        escalated: number;
      }, []>("SELECT * FROM review_passes ORDER BY id DESC LIMIT 1")
      .get();
    expect(row!.issue_id).toBe("issue-1");
    expect(row!.verdict).toBe("approve");
    expect(row!.provider_used).toBe("deepseek");
    expect(row!.duration_ms).toBe(4_500);
    expect(row!.escalated).toBe(0);
  });

  it("accepts null providerUsed for failed reviews", () => {
    recordReviewPass(db, {
      issueLinearId: "issue-1",
      fingerprint: "fp-fail",
      round: 1,
      verdict: "failed",
      findingCount: 0,
      advisoryCount: 0,
      providerUsed: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: 100,
      escalated: false,
    });
    const row = db
      .query<{ provider_used: string | null }, []>(
        "SELECT provider_used FROM review_passes ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(row!.provider_used).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-queries.test.ts`
Expected: FAIL — both `review_passes` table and `recordReviewPass` don't exist yet.

- [ ] **Step 3: Add the `review_passes` table to schema**

Append to `src/state/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS review_passes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  round           INTEGER NOT NULL,
  verdict         TEXT NOT NULL,
  finding_count   INTEGER NOT NULL,
  advisory_count  INTEGER NOT NULL,
  provider_used   TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  duration_ms     INTEGER NOT NULL,
  escalated       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES tickets(linear_id)
);

CREATE INDEX IF NOT EXISTS idx_review_passes_issue ON review_passes(issue_id);
CREATE INDEX IF NOT EXISTS idx_review_passes_verdict ON review_passes(verdict, created_at);
```

- [ ] **Step 4: Implement `recordReviewPass`**

Create `src/state/review-queries.ts`:

```typescript
import type { DB } from "./db.ts";

export type ReviewVerdict = "approve" | "changes_needed" | "failed";

export interface ReviewPassInput {
  issueLinearId: string;
  fingerprint: string;
  round: number;
  verdict: ReviewVerdict;
  findingCount: number;
  advisoryCount: number;
  providerUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  escalated: boolean;
}

export function recordReviewPass(db: DB, input: ReviewPassInput): void {
  db.query(
    `INSERT INTO review_passes (
       issue_id, fingerprint, round, verdict,
       finding_count, advisory_count, provider_used,
       input_tokens, output_tokens, duration_ms, escalated
     ) VALUES (
       $issue, $fp, $round, $verdict,
       $findings, $advisories, $provider,
       $inTok, $outTok, $dur, $esc
     )`,
  ).run({
    issue: input.issueLinearId,
    fp: input.fingerprint,
    round: input.round,
    verdict: input.verdict,
    findings: input.findingCount,
    advisories: input.advisoryCount,
    provider: input.providerUsed,
    inTok: input.inputTokens,
    outTok: input.outputTokens,
    dur: input.durationMs,
    esc: input.escalated ? 1 : 0,
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/review-queries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/schema.sql src/state/review-queries.ts test/review-queries.test.ts
git commit -m "feat(state): add review_passes table and recordReviewPass"
```

---

## Task 2: Capture run-log in agent loop

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/tools.ts`
- Test: `test/agent-loop-phases.test.ts` (extend)

The reviewer needs to know what shell commands the primary actually ran. We add a `RunLogEntry[]` collector that the bash tool writes to on every invocation, exposed alongside the loop's existing return value. Tokens in commands are redacted via the existing `redactGitHubTokens` helper.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-loop-phases.test.ts` in a new `describe`:

```typescript
import { redactGitHubTokens } from "../src/redact.ts";

describe("run-log capture", () => {
  it("records run_bash invocations with command and exit code", async () => {
    const glm = fakeGlm([
      (_msgs) => turnWithToolUse("run_bash", { command: "echo hi" }),
      (_msgs) => turnWithToolUse("run_bash", { command: "false" }),
      (_msgs) => turnWithToolUse("finish", { summary: "done" }),
    ]);
    const exec = fakeExecutor();
    let calls = 0;
    exec.run = async (cmd: string): Promise<ExecResult> => {
      calls++;
      return {
        stdout: "",
        stderr: "",
        exitCode: cmd === "false" ? 1 : 0,
        timedOut: false,
      };
    };
    const result = await runAgentLoop({
      glm,
      executor: exec,
      systemPrompt: "you are a test agent",
      task: "run two commands then finish",
      maxIterations: 10,
      timeoutMs: 60_000,
    });
    expect(result.status).toBe("finished");
    expect(result.runLog.length).toBe(2);
    expect(result.runLog[0]!.cmd).toBe("echo hi");
    expect(result.runLog[0]!.exit).toBe(0);
    expect(result.runLog[1]!.cmd).toBe("false");
    expect(result.runLog[1]!.exit).toBe(1);
  });

  it("redacts github tokens in captured commands", async () => {
    const glm = fakeGlm([
      (_msgs) =>
        turnWithToolUse("run_bash", {
          command:
            "git fetch https://x-access-token:ghs_secret@github.com/owner/repo.git",
        }),
      (_msgs) => turnWithToolUse("finish", { summary: "done" }),
    ]);
    const result = await runAgentLoop({
      glm,
      executor: fakeExecutor(),
      systemPrompt: "test",
      task: "fetch then finish",
      maxIterations: 5,
      timeoutMs: 60_000,
    });
    expect(result.runLog.length).toBe(1);
    expect(result.runLog[0]!.cmd).toContain("[REDACTED]");
    expect(result.runLog[0]!.cmd).not.toContain("ghs_secret");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/agent-loop-phases.test.ts`
Expected: FAIL — `result.runLog` doesn't exist yet.

- [ ] **Step 3: Add `RunLogEntry` to `AgentLoopResult`**

In `src/agent/loop.ts`, near the top:

```typescript
import { redactGitHubTokens } from "../redact.ts";

export interface RunLogEntry {
  cmd: string;
  exit: number;
  ts: number;
}
```

Extend the `AgentLoopResult` interface to include `runLog: readonly RunLogEntry[]`.

- [ ] **Step 4: Wire run-log collection through the loop**

Inside `runAgentLoop`:

```typescript
const runLog: RunLogEntry[] = [];
```

Pass into makeToolset:

```typescript
const tools = makeToolset(args.executor, { ...toolsetOpts, runLog });
```

Include in every `done(...)` return:

```typescript
const base: AgentLoopResult = {
  status, summary, iterations: totalIterations,
  inputTokens: usage.input, outputTokens: usage.output,
  cacheCreationTokens: usage.cacheCreation, cacheReadTokens: usage.cacheRead,
  phase, runLog,
};
```

- [ ] **Step 5: Wire run-log collection through the toolset**

In `src/agent/tools.ts`, extend `ToolsetOptions` with `runLog?: RunLogEntry[]`. Update `runBashTool`'s factory signature to accept it and append on every invocation:

```typescript
if (runLog) {
  runLog.push({
    cmd: redactGitHubTokens(args.command),
    exit: r.exitCode,
    ts: Date.now(),
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/agent-loop-phases.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS — additive change.

- [ ] **Step 8: Commit**

```bash
git add src/agent/loop.ts src/agent/tools.ts test/agent-loop-phases.test.ts
git commit -m "feat(agent): capture run-log during agent loop"
```

---

## Task 3: Pre-check (a) untested-export detection

**Files:**
- Create: `src/review/precheck.ts`
- Create: `test/review-precheck.test.ts`

Parses a unified diff for new/changed `export function`, `export const`, `export class`, `export default function/class` declarations on added lines, then greps `test/**/*.ts` for an import or string reference; flags exports with no test reference.

- [ ] **Step 1: Write the failing test**

Create `test/review-precheck.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { findUntestedExports } from "../src/review/precheck.ts";

const DIFF_NEW_EXPORT_NO_TEST = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,7 @@
 import { something } from "./bar";

+export function buildPayload(input: string): string {
+  return input.toUpperCase();
+}
+
 export const VERSION = "1.0.0";
`;

describe("findUntestedExports", () => {
  it("flags a new exported function with no test reference", async () => {
    const findings = await findUntestedExports({
      diff: DIFF_NEW_EXPORT_NO_TEST,
      grep: async (_pattern: string) => [],
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("buildPayload");
    expect(findings[0]!.file).toBe("src/foo.ts");
    expect(findings[0]!.kind).toBe("untested_export");
  });

  it("does NOT flag exports that have a test reference", async () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
+export function buildPayload(input: string): string {
+  return input.toUpperCase();
+}
`;
    const findings = await findUntestedExports({
      diff,
      grep: async (pattern: string) => {
        if (pattern === "buildPayload") {
          return [
            { path: "test/foo.test.ts", line: 4, text: 'import { buildPayload } from "../src/foo.ts";' },
          ];
        }
        return [];
      },
    });
    expect(findings).toEqual([]);
  });

  it("ignores private (non-exported) declarations", async () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
+function privateHelper() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    expect(findings).toEqual([]);
  });

  it("detects exported const, class, and default function", async () => {
    const diff = `diff --git a/src/multi.ts b/src/multi.ts
index 1111111..2222222 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1 +1,5 @@
+export const COLOR_TABLE = { red: "#ff0000" };
+export class Widget {}
+export default function defaultThing() {}
+export async function asyncOp() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    const names = findings.map((f) => f.name).sort();
    expect(names).toEqual(["COLOR_TABLE", "Widget", "asyncOp", "defaultThing"]);
  });

  it("only considers added lines, not removed", async () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,5 +1,5 @@
 export function staysTheSame() {}
-export function removedFn() {}
+export function addedFn() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    expect(findings.map((f) => f.name)).toEqual(["addedFn"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-precheck.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `findUntestedExports`**

Create `src/review/precheck.ts`:

```typescript
export type PrecheckKind = "untested_export" | "unwired_identifier";

export interface PrecheckFinding {
  kind: PrecheckKind;
  name: string;
  file: string;
  line?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export type GrepFn = (pattern: string, pathGlob?: string) => Promise<readonly GrepMatch[]>;

export interface FindUntestedExportsArgs {
  diff: string;
  grep: GrepFn;
  skipPrefixes?: readonly string[];
}

interface AddedExport { name: string; file: string }

const DEFAULT_SKIP_PREFIXES: readonly string[] = ["test/", "tests/"];

const EXPORT_PATTERNS: readonly RegExp[] = [
  /^\+\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+class\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
];

export function parseAddedExports(
  diff: string,
  skipPrefixes: readonly string[] = DEFAULT_SKIP_PREFIXES,
): AddedExport[] {
  const lines = diff.split("\n");
  const out: AddedExport[] = [];
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice("+++ b/".length); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (currentFile === null) continue;
    if (skipPrefixes.some((p) => currentFile!.startsWith(p))) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of EXPORT_PATTERNS) {
      const m = line.match(pattern);
      if (m && m[1]) { out.push({ name: m[1], file: currentFile }); break; }
    }
  }
  return out;
}

export async function findUntestedExports(args: FindUntestedExportsArgs): Promise<PrecheckFinding[]> {
  const exports = parseAddedExports(args.diff, args.skipPrefixes);
  const findings: PrecheckFinding[] = [];
  for (const exp of exports) {
    const matches = await args.grep(exp.name, "test/**/*.ts");
    if (matches.length === 0) {
      findings.push({ kind: "untested_export", name: exp.name, file: exp.file });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/review-precheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/precheck.ts test/review-precheck.test.ts
git commit -m "feat(review): add untested-export pre-check"
```

---

## Task 4: Pre-check (b) unwired-identifier detection

**Files:**
- Modify: `src/review/precheck.ts`
- Modify: `test/review-precheck.test.ts`

Detects new string-literal identifiers introduced by the diff (query params, event names, storage keys) that appear nowhere outside the file that introduced them. Catches PR #47 class.

- [ ] **Step 1: Add the failing test**

Append to `test/review-precheck.test.ts`:

```typescript
import { findUnwiredIdentifiers } from "../src/review/precheck.ts";

describe("findUnwiredIdentifiers", () => {
  it("flags a query param string that has no consumer", async () => {
    const diff = `diff --git a/src/routes/log/+page.svelte b/src/routes/log/+page.svelte
index 1111111..2222222 100644
--- a/src/routes/log/+page.svelte
+++ b/src/routes/log/+page.svelte
@@ -10,3 +10,5 @@
 <a href="/log">log</a>
+<a href="/log?unidentified=true">unidentified</a>
+<a href="/log?reviewed=true">reviewed</a>
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "unidentified=true") {
          return [
            { path: "src/routes/log/+page.svelte", line: 12,
              text: '<a href="/log?unidentified=true">unidentified</a>' },
          ];
        }
        if (pattern === "reviewed=true") {
          return [
            { path: "src/routes/log/+page.svelte", line: 13, text: 'reviewed' },
            { path: "src/routes/log/quick/[sessionId]/+page.svelte", line: 8,
              text: 'if (params.has("reviewed")) {' },
          ];
        }
        return [];
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("unidentified=true");
    expect(findings[0]!.kind).toBe("unwired_identifier");
  });

  it("flags an event name that no consumer listens for", async () => {
    const diff = `diff --git a/src/lib/events.ts b/src/lib/events.ts
index 1111111..2222222 100644
--- a/src/lib/events.ts
+++ b/src/lib/events.ts
@@ -1,1 +1,2 @@
 emit("user.created", payload);
+emit("session.expired", payload);
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "session.expired") {
          return [
            { path: "src/lib/events.ts", line: 2,
              text: 'emit("session.expired", payload);' },
          ];
        }
        return [];
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("session.expired");
  });

  it("does NOT flag identifiers when the diff has the consumer", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+emit("foo.bar", x);
diff --git a/src/b.ts b/src/b.ts
+on("foo.bar", handler);
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "foo.bar") {
          return [
            { path: "src/a.ts", line: 1, text: 'emit("foo.bar", x);' },
            { path: "src/b.ts", line: 1, text: 'on("foo.bar", handler);' },
          ];
        }
        return [];
      },
    });
    expect(findings).toEqual([]);
  });

  it("ignores short or generic strings", async () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
+const z = "ok";
+const w = "1";
+const t = "";
`;
    const findings = await findUnwiredIdentifiers({ diff, grep: async () => [] });
    expect(findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-precheck.test.ts`
Expected: FAIL — `findUnwiredIdentifiers` doesn't exist.

- [ ] **Step 3: Implement `findUnwiredIdentifiers`**

Append to `src/review/precheck.ts`:

```typescript
export interface FindUnwiredIdentifiersArgs {
  diff: string;
  grep: GrepFn;
}

interface AddedIdentifier { name: string; file: string }

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /[?&]([a-z][a-z0-9_-]{2,}=[a-z0-9_-]{2,})/gi,
  /["']([a-z][a-z0-9_.-]{3,})["']/gi,
];

const STOPWORDS = new Set(["true", "false", "null", "undefined", "none", "default"]);

function looksGenericName(s: string): boolean {
  if (STOPWORDS.has(s.toLowerCase())) return true;
  if (/^[0-9.]+$/.test(s)) return true;
  if (s.length < 4) return true;
  return false;
}

export function parseAddedIdentifiers(diff: string): AddedIdentifier[] {
  const lines = diff.split("\n");
  const out: AddedIdentifier[] = [];
  const seen = new Set<string>();
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice("+++ b/".length); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (currentFile === null) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        const name = m[1]!;
        if (looksGenericName(name)) continue;
        const key = `${currentFile}::${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, file: currentFile });
      }
    }
  }
  return out;
}

export async function findUnwiredIdentifiers(args: FindUnwiredIdentifiersArgs): Promise<PrecheckFinding[]> {
  const ids = parseAddedIdentifiers(args.diff);
  const findings: PrecheckFinding[] = [];
  for (const id of ids) {
    const matches = await args.grep(id.name);
    const otherFiles = new Set<string>();
    for (const m of matches) if (m.path !== id.file) otherFiles.add(m.path);
    if (otherFiles.size === 0) {
      findings.push({ kind: "unwired_identifier", name: id.name, file: id.file });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/review-precheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/precheck.ts test/review-precheck.test.ts
git commit -m "feat(review): add unwired-identifier pre-check"
```

---

## Task 5: Provider chain reorder helper

**Files:**
- Modify: `src/providers.ts`
- Modify: `test/providers.test.ts`

The reviewer needs a chain with a different provider order than primary. Add `chainWithOrder` for arbitrary preferences.

- [ ] **Step 1: Add the failing test**

Append to `test/providers.test.ts` (check existing imports first; add `LLMProvider` and `createRateLimitGate` only if not already imported):

```typescript
import { chainWithOrder, createProviderChain } from "../src/providers.ts";

describe("chainWithOrder", () => {
  function fakeProvider(name: ProviderName): LLMProvider {
    return {
      name, model: name, client: {} as AnthropicClient,
      gate: createRateLimitGate(),
      defaultBackoffMs: 60_000,
      parse429: () => null,
    };
  }

  it("reorders providers to match the requested preference", () => {
    const zai = fakeProvider("z.ai");
    const kimi = fakeProvider("kimi");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek", "z.ai", "kimi"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai", "kimi"]);
  });

  it("ignores names not present in the canonical chain", () => {
    const zai = fakeProvider("z.ai");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek", "kimi", "z.ai"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai"]);
  });

  it("appends unrequested providers at the end in canonical order", () => {
    const zai = fakeProvider("z.ai");
    const kimi = fakeProvider("kimi");
    const deepseek = fakeProvider("deepseek");
    const canonical = createProviderChain([zai, kimi, deepseek]);
    const reordered = chainWithOrder(canonical, ["deepseek"]);
    expect(reordered.providers.map((p) => p.name)).toEqual(["deepseek", "z.ai", "kimi"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/providers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `chainWithOrder`**

Append to `src/providers.ts`:

```typescript
export function chainWithOrder(
  canonical: ProviderChain,
  requested: readonly ProviderName[],
): ProviderChain {
  const byName = new Map(canonical.providers.map((p) => [p.name, p]));
  const ordered: LLMProvider[] = [];
  const used = new Set<ProviderName>();
  for (const name of requested) {
    const p = byName.get(name);
    if (p && !used.has(name)) { ordered.push(p); used.add(name); }
  }
  for (const p of canonical.providers) {
    if (!used.has(p.name)) ordered.push(p);
  }
  return createProviderChain(ordered);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers.ts test/providers.test.ts
git commit -m "feat(providers): add chainWithOrder for arbitrary preferences"
```

---

## Task 6: Reviewer config

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

Add config loading for `GARY_REVIEWER_PROVIDER_ORDER`, `GARY_REVIEW_MAX_ROUNDS`, `GARY_REVIEW_ITERATION_CAP`, `GARY_REVIEW_TIMEOUT_MS`.

- [ ] **Step 1: Add the failing test**

Append to `test/config.test.ts` (add `afterEach` to imports if not already present):

```typescript
import { loadReviewConfig } from "../src/config.ts";

describe("loadReviewConfig", () => {
  const originals: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in originals)) originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    Object.keys(originals).forEach((k) => delete originals[k]);
  });

  it("returns defaults when no env vars are set", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", undefined);
    setEnv("GARY_REVIEW_MAX_ROUNDS", undefined);
    setEnv("GARY_REVIEW_ITERATION_CAP", undefined);
    setEnv("GARY_REVIEW_TIMEOUT_MS", undefined);
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["deepseek", "z.ai", "kimi"]);
    expect(cfg.maxRounds).toBe(3);
    expect(cfg.iterationCap).toBe(15);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("respects GARY_REVIEWER_PROVIDER_ORDER", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "kimi,deepseek");
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["kimi", "deepseek"]);
  });

  it("ignores unknown provider names", () => {
    setEnv("GARY_REVIEWER_PROVIDER_ORDER", "deepseek,gpt5,kimi");
    const cfg = loadReviewConfig();
    expect(cfg.providerOrder).toEqual(["deepseek", "kimi"]);
  });

  it("respects integer overrides", () => {
    setEnv("GARY_REVIEW_MAX_ROUNDS", "2");
    setEnv("GARY_REVIEW_ITERATION_CAP", "10");
    setEnv("GARY_REVIEW_TIMEOUT_MS", "180000");
    const cfg = loadReviewConfig();
    expect(cfg.maxRounds).toBe(2);
    expect(cfg.iterationCap).toBe(10);
    expect(cfg.timeoutMs).toBe(180_000);
  });

  it("throws on non-integer values", () => {
    setEnv("GARY_REVIEW_MAX_ROUNDS", "two");
    expect(() => loadReviewConfig()).toThrow(/integer/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `loadReviewConfig` doesn't exist.

- [ ] **Step 3: Add `ReviewConfig` type and `loadReviewConfig`**

Append to `src/config.ts`:

```typescript
export interface ReviewConfig {
  providerOrder: readonly ProviderName[];
  maxRounds: number;
  iterationCap: number;
  timeoutMs: number;
}

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(["z.ai", "kimi", "deepseek"]);

export function loadReviewConfig(): ReviewConfig {
  const orderRaw = optionalString("GARY_REVIEWER_PROVIDER_ORDER");
  const providerOrder = (orderRaw ?? "deepseek,z.ai,kimi")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ProviderName => KNOWN_PROVIDERS.has(s));
  return {
    providerOrder,
    maxRounds: intFromEnv("GARY_REVIEW_MAX_ROUNDS", 3),
    iterationCap: intFromEnv("GARY_REVIEW_ITERATION_CAP", 15),
    timeoutMs: intFromEnv("GARY_REVIEW_TIMEOUT_MS", 300_000),
  };
}
```

Add `review: ReviewConfig` to the `Config` interface and populate it in `loadConfig()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add reviewer pass env loading"
```

---

## Task 7: Reviewer toolset

**Files:**
- Create: `src/review/tools.ts`
- Create: `test/review-tools.test.ts`

Build a separate toolset for the reviewer. Exposes read_file, grep, list_files, run_bash, fetch_url, and a new `submit_review` tool. Does NOT expose write_file, edit_file, commit, or finish.

- [ ] **Step 1: Write the failing test**

Create `test/review-tools.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { makeReviewerToolset } from "../src/review/tools.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";

function fakeExecutor(): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() { return "fake"; },
    async writeFile() {},
    async listFiles(): Promise<string[]> { return []; },
    async grep(): Promise<GrepMatch[]> { return []; },
    async run(): Promise<ExecResult> {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

describe("makeReviewerToolset", () => {
  it("exposes only read+run+submit_review tools", () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const names = tools.definitions.map((d) => d.name).sort();
    expect(names).toEqual(["fetch_url", "grep", "list_files", "read_file", "run_bash", "submit_review"]);
    expect(tools.handlers["write_file"]).toBeUndefined();
    expect(tools.handlers["edit_file"]).toBeUndefined();
    expect(tools.handlers["commit"]).toBeUndefined();
    expect(tools.handlers["finish"]).toBeUndefined();
  });

  it("submit_review with approve captures the review", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const result = await tools.handlers["submit_review"]!.run({
      verdict: "approve",
      findings: [],
      advisory_notes: ["consider adding a test for the helper"],
      verification_report: "## Verification\n\n- ran tests, all pass",
    });
    expect(result).toBe("review submitted");
    expect(tools.review).not.toBeNull();
    expect(tools.review!.verdict).toBe("approve");
    expect(tools.review!.advisoryNotes).toEqual(["consider adding a test for the helper"]);
  });

  it("submit_review with changes_needed requires non-empty findings", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const r = await tools.handlers["submit_review"]!.run({
      verdict: "changes_needed",
      findings: [],
      advisory_notes: [],
      verification_report: "",
    });
    expect(r).toMatch(/findings.*non-empty|at least one finding/i);
    expect(tools.review).toBeNull();
  });

  it("submit_review with approve rejects non-empty findings", async () => {
    const tools = makeReviewerToolset(fakeExecutor());
    const r = await tools.handlers["submit_review"]!.run({
      verdict: "approve",
      findings: [{ title: "broken", detail: "no", bug_class: "wrong_code_path" }],
      advisory_notes: [],
      verification_report: "",
    });
    expect(r).toMatch(/approve.*findings|cannot approve/i);
    expect(tools.review).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-tools.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the reviewer toolset**

Create `src/review/tools.ts`. Structure:

- `BugClass`, `ReviewFinding`, `ReviewVerdict`, `SubmittedReview`, `ReviewerTools`, `ReviewerToolHandler` types
- `makeReviewerToolset(executor, opts)` factory with internal helpers:
  - `readFileTool` — same as primary's read_file (with readCache dedupe)
  - `grepTool` — wraps `executor.grep`
  - `listFilesTool` — wraps `executor.listFiles`
  - `runBashTool` — wraps `executor.run`, appends to `runLog` with redacted command
  - `fetchUrlTool` — same as primary's
  - `submitReviewTool` — zod-parsed schema; enforces approve-without-findings and changes_needed-with-findings invariants; sets `tools.review` on success

The `submit_review` tool's input_schema (Anthropic JSON schema):

```typescript
{
  verdict: { type: "string", enum: ["approve", "changes_needed"] },
  findings: { type: "array", items: { type: "object",
    properties: {
      title: { type: "string" },
      detail: { type: "string" },
      location: { type: "object", properties: { file: { type: "string" }, line: { type: "number" } }, required: ["file"] },
      bug_class: { type: "string", enum: ["wrong_code_path", "unverified_claim", "half_wired", "untested_logic"] },
    },
    required: ["title", "detail", "bug_class"],
  }},
  advisory_notes: { type: "array", items: { type: "string" } },
  verification_report: { type: "string" },
}
```

The handler logic:

```typescript
async run(input) {
  const parsed = submitReviewSchema.parse(input);
  if (parsed.verdict === "changes_needed" && parsed.findings.length === 0) {
    return "error: changes_needed verdict requires at least one finding (non-empty findings array)";
  }
  if (parsed.verdict === "approve" && parsed.findings.length > 0) {
    return "error: cannot approve with findings — either drop them to advisory_notes or change verdict to changes_needed";
  }
  tools.review = {
    verdict: parsed.verdict,
    findings: parsed.findings.map((f) => ({
      title: f.title, detail: f.detail,
      ...(f.location ? { location: f.location } : {}),
      bugClass: f.bug_class,
    })),
    advisoryNotes: parsed.advisory_notes,
    verificationReport: parsed.verification_report,
  };
  return "review submitted";
}
```

The `runBashTool` should append to `tools.runLog` (same shape as primary's `RunLogEntry`):

```typescript
tools.runLog.push({
  cmd: redactGitHubTokens(args.command),
  exit: r.exitCode,
  ts: Date.now(),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/review-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review/tools.ts test/review-tools.test.ts
git commit -m "feat(review): add reviewer toolset with submit_review"
```

---

## Task 8: Reviewer prompts

**Files:**
- Create: `src/review/prompts.ts`
- Create: `test/review-prompts.test.ts`

The reviewer's task instructions and system prompt composer. Reuses voice.md via `composeSystemPrompt` with reviewer-specific instructions.

- [ ] **Step 1: Write the failing test**

Create `test/review-prompts.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { REVIEW_TASK_INSTRUCTIONS, composeReviewerSystemPrompt, renderReviewTask } from "../src/review/prompts.ts";
import type { RunLogEntry } from "../src/agent/loop.ts";
import type { PrecheckFinding } from "../src/review/precheck.ts";

describe("REVIEW_TASK_INSTRUCTIONS", () => {
  it("frames the reviewer as a bug-finder, not a style critic", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/bug/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/style|refactor|advisory/i);
  });
  it("lists the four bug classes", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/wrong[_\s]code[_\s]path/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/unverified[_\s]claim/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/half[_\s-]wired/i);
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/untested[_\s]logic/i);
  });
  it("instructs to call submit_review", () => {
    expect(REVIEW_TASK_INSTRUCTIONS).toMatch(/submit_review/);
  });
});

describe("renderReviewTask", () => {
  const ticket = { identifier: "ERT-1", title: "fix the foo", description: "foo is broken" };

  it("includes the diff, run-log, ticket, and pre-check findings", () => {
    const runLog: RunLogEntry[] = [
      { cmd: "bun test", exit: 0, ts: 1 },
      { cmd: "git status", exit: 0, ts: 2 },
    ];
    const precheck: PrecheckFinding[] = [
      { kind: "untested_export", name: "buildPayload", file: "src/foo.ts" },
    ];
    const out = renderReviewTask({
      ticket, diff: "diff --git a/src/foo.ts b/src/foo.ts",
      runLog, precheckFindings: precheck, previousFindings: [], worktreePath: "/tmp/wt",
    });
    expect(out).toContain("ERT-1");
    expect(out).toContain("foo is broken");
    expect(out).toContain("bun test");
    expect(out).toContain("git status");
    expect(out).toContain("buildPayload");
  });

  it("includes prior-round findings when re-reviewing", () => {
    const out = renderReviewTask({
      ticket, diff: "...", runLog: [], precheckFindings: [],
      previousFindings: [{ title: "missing receiver", detail: "no consumer", bugClass: "half_wired" }],
      worktreePath: "/tmp/wt",
    });
    expect(out).toMatch(/previous round|round 1|earlier finding/i);
    expect(out).toContain("missing receiver");
  });

  it("flags an empty run-log explicitly", () => {
    const out = renderReviewTask({
      ticket, diff: "...", runLog: [], precheckFindings: [],
      previousFindings: [], worktreePath: "/tmp/wt",
    });
    expect(out).toMatch(/no.*commands|empty.*run.log|did not run/i);
  });
});

describe("composeReviewerSystemPrompt", () => {
  it("includes the review task instructions", () => {
    expect(composeReviewerSystemPrompt()).toContain(REVIEW_TASK_INSTRUCTIONS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-prompts.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the prompts module**

Create `src/review/prompts.ts`. Define:

- `REVIEW_TASK_INSTRUCTIONS` — multi-paragraph string. Frame: "find ONE concrete blocking bug; if you can't, approve". List the four bug classes (wrong_code_path, unverified_claim, half_wired, untested_logic). Forbid blocking on style/refactor/scope. Call out: read diff, check run-log, evaluate pre-check findings, use run_bash to verify, then call submit_review.
- `composeReviewerSystemPrompt()` — `composeSystemPrompt({ taskInstructions: REVIEW_TASK_INSTRUCTIONS })`
- `ReviewTaskTicket` type, `RenderReviewTaskArgs` type
- `renderReviewTask(args)` — assembles the user message: worktree, ticket, diff (truncated to 30KB), run-log section (or "(empty — strong unverified-claim signal if diff is non-trivial)"), pre-check findings, previous-round findings (only if non-empty)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/review-prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review/prompts.ts test/review-prompts.test.ts
git commit -m "feat(review): add reviewer prompts (system + task)"
```

---

## Task 9: runReviewer orchestration

**Files:**
- Create: `src/review/runner.ts`
- Create: `test/review-runner.test.ts`

The orchestrator. Takes a fresh `GLMClient` (built from a reordered chain), runs an agent loop with the reviewer toolset, persists the result via `recordReviewPass`, and returns a structured outcome the code handler can act on.

- [ ] **Step 1: Write the failing test**

Create `test/review-runner.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { GLMClient } from "../src/adapters/glm.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";
import { runReviewer } from "../src/review/runner.ts";

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/state/schema.sql");

function freshDb(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.query("INSERT INTO tickets (linear_id, identifier) VALUES ('issue-1', 'ERT-1')").run();
  return db;
}

function fakeExecutor(): Executor {
  return {
    workspaceRoot: "/tmp/fake",
    async readFile() { return ""; },
    async writeFile() {},
    async listFiles(): Promise<string[]> { return []; },
    async grep(): Promise<GrepMatch[]> { return []; },
    async run(): Promise<ExecResult> { return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; },
  };
}

const STANDARD_USAGE = {
  input_tokens: 100, output_tokens: 50,
  cache_creation_input_tokens: null, cache_read_input_tokens: null,
} as unknown as Anthropic.Usage;

function approveTurn(): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{
      type: "tool_use", id: "tu_1", name: "submit_review",
      input: {
        verdict: "approve", findings: [], advisory_notes: [],
        verification_report: "## Verification\n\n- read the diff\n- nothing concerning",
      },
    }],
    stop_reason: "tool_use", stop_sequence: null, usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

function changesNeededTurn(): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "fake",
    content: [{
      type: "tool_use", id: "tu_1", name: "submit_review",
      input: {
        verdict: "changes_needed",
        findings: [{ title: "missing receiver", detail: "no consumer", bug_class: "half_wired" }],
        advisory_notes: [],
        verification_report: "found unwired param",
      },
    }],
    stop_reason: "tool_use", stop_sequence: null, usage: STANDARD_USAGE,
  } as Anthropic.Message;
}

function fakeGlm(turns: Array<() => Anthropic.Message>): GLMClient {
  let i = 0;
  return {
    async createMessage(): Promise<Anthropic.Message> {
      const make = turns[i++];
      if (!make) throw new Error("no scripted turn");
      return make();
    },
    chain: {
      providers: [{ name: "deepseek", model: "deepseek-v4-pro" } as never],
      active: () => ({ name: "deepseek", model: "deepseek-v4-pro" }) as never,
      allArmed: () => false,
      earliestReset: () => null,
    },
  } as unknown as GLMClient;
}

describe("runReviewer", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  it("returns approve verdict and persists a row", async () => {
    const result = await runReviewer({
      db, glm: fakeGlm([approveTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind === "verdict") expect(result.review.verdict).toBe("approve");
    const row = db.query<{ verdict: string; round: number }, []>(
      "SELECT verdict, round FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("approve");
    expect(row!.round).toBe(1);
  });

  it("returns changes_needed and persists with finding count", async () => {
    const result = await runReviewer({
      db, glm: fakeGlm([changesNeededTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 2,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("verdict");
    if (result.kind === "verdict") {
      expect(result.review.verdict).toBe("changes_needed");
      expect(result.review.findings.length).toBe(1);
    }
    const row = db.query<{ verdict: string; finding_count: number }, []>(
      "SELECT verdict, finding_count FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("changes_needed");
    expect(row!.finding_count).toBe(1);
  });

  it("returns kind=failed and persists when the agent loop times out", async () => {
    const glm = {
      async createMessage(): Promise<Anthropic.Message> {
        await new Promise((r) => setTimeout(r, 200));
        return approveTurn();
      },
      chain: {
        providers: [{ name: "deepseek", model: "deepseek-v4-pro" } as never],
        active: () => ({ name: "deepseek", model: "deepseek-v4-pro" }) as never,
        allArmed: () => false, earliestReset: () => null,
      },
    } as unknown as GLMClient;
    const result = await runReviewer({
      db, glm, executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 50,
    });
    expect(result.kind).toBe("failed");
    const row = db.query<{ verdict: string }, []>(
      "SELECT verdict FROM review_passes ORDER BY id DESC LIMIT 1"
    ).get();
    expect(row!.verdict).toBe("failed");
  });

  it("returns kind=failed when the agent doesn't call submit_review", async () => {
    const noSubmitTurn = (): Anthropic.Message => ({
      id: "m", type: "message", role: "assistant", model: "fake",
      content: [{ type: "text", text: "I refuse" }],
      stop_reason: "end_turn", stop_sequence: null, usage: STANDARD_USAGE,
    } as Anthropic.Message);
    const result = await runReviewer({
      db, glm: fakeGlm([noSubmitTurn]), executor: fakeExecutor(),
      ticket: { identifier: "ERT-1", title: "t", description: null },
      issueLinearId: "issue-1", fingerprint: "fp-1", round: 1,
      diff: "diff", runLog: [], precheckFindings: [], previousFindings: [],
      worktreePath: "/tmp/wt", iterationCap: 5, timeoutMs: 60_000,
    });
    expect(result.kind).toBe("failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/review-runner.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `runReviewer`**

Create `src/review/runner.ts`. Sketch:

- Define `ReviewerResult = { kind: "verdict"; review: SubmittedReview } | { kind: "failed"; reason: string }`
- Define `RunReviewerArgs` with: db, glm, executor, ticket, issueLinearId, fingerprint, round, diff, runLog, precheckFindings, previousFindings, worktreePath, iterationCap, timeoutMs
- Build `tools = makeReviewerToolset(executor)` and `system = composeReviewerSystemPrompt()`
- Build user message via `renderReviewTask(...)`
- Loop: call `glm.createMessage`, dispatch tool calls, append tool_results, exit when `tools.review !== null`
- Track tokens (sum from `response.usage`), track providerName from `glm.chain.providers[0]?.name`
- On AllProvidersExhaustedError, set `failureReason = "providers_exhausted"`, break
- On timeout or other error, capture and break
- Persist via `recordReviewPass`: verdict = `tools.review.verdict` if set, else `"failed"`
- Return `{ kind: "verdict", review: tools.review }` or `{ kind: "failed", reason }`

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/review-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review/runner.ts test/review-runner.test.ts
git commit -m "feat(review): add runReviewer orchestration"
```

---

## Task 10: review_rejected escalation reason

**Files:**
- Modify: `src/escalate.ts`
- Optional test: `test/escalate.test.ts` (only if exists)

Add the new `EscalationReason` value with a synthesizer that splices in the final round's finding titles.

- [ ] **Step 1: Check whether `test/escalate.test.ts` exists**

Run: `ls test/escalate.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

- [ ] **Step 2 (only if EXISTS): add a failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { synthesizeReviewRejectedBody } from "../src/escalate.ts";

describe("synthesizeReviewRejectedBody", () => {
  it("includes the round count and finding titles", () => {
    const body = synthesizeReviewRejectedBody({
      finalFindings: [
        { title: "missing receiver", bugClass: "half_wired" },
        { title: "untested SQL", bugClass: "untested_logic" },
      ],
    });
    expect(body).toContain("3 swings");
    expect(body).toContain("missing receiver");
    expect(body).toContain("untested SQL");
  });
});
```

Run: `bun test test/escalate.test.ts` — expect FAIL.

- [ ] **Step 3: Add the new reason and synthesizer**

In `src/escalate.ts`:

Extend the union: add `"review_rejected"` to `EscalationReason`.

Add to `DEFAULT_MESSAGES`:

```typescript
review_rejected:
  "took 3 swings at this and the reviewer kept finding issues. bouncing so a human can decide whether to retry, split, or fix directly.",
```

Add the synthesizer:

```typescript
export interface SynthesizeReviewRejectedArgs {
  finalFindings: readonly { title: string; bugClass: string }[];
}

export function synthesizeReviewRejectedBody(args: SynthesizeReviewRejectedArgs): string {
  const lines = [
    "took 3 swings at this and the reviewer kept finding issues. bouncing so a human can decide whether to retry, split, or fix directly.",
    "",
    "last round's blockers:",
  ];
  for (const f of args.finalFindings) lines.push(`- ${f.title}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/escalate.ts test/escalate.test.ts 2>/dev/null || git add src/escalate.ts
git commit -m "feat(escalate): add review_rejected escalation reason"
```

---

## Task 11: Wire the reviewer into the code handler

**Files:**
- Modify: `src/handlers/code.ts`
- Modify: `src/index.ts`

Insert the reviewer pass between `ensurePostFinishCheckPasses` and the rebase-and-push block. On `changes_needed`, re-run the agent with the findings as a fixup task. After 3 rejections, escalate via `review_rejected`. On reviewer failure, retry once; if still failing, default-approve.

This task is integration-heavy. Coverage comes from manual smoke testing in Task 14.

- [ ] **Step 1: Extend `CodeHandlerDeps` with review config**

Add to `CodeHandlerDeps` in `src/handlers/code.ts`:

```typescript
import type { ReviewConfig } from "../config.ts";

export interface CodeHandlerDeps {
  // ...existing fields...
  review: ReviewConfig;
}
```

- [ ] **Step 2: Wire `loadReviewConfig()` through `src/index.ts`**

Wherever `CodeHandlerDeps` is constructed, populate `review: cfg.review`.

- [ ] **Step 3: Insert the reviewer loop**

Between `ensurePostFinishCheckPasses` and the rebase block (line ~291 in current code.ts), insert:

```typescript
const reviewerGlm = new GLMClient(
  chainWithOrder(deps.glm.chain, deps.review.providerOrder),
);
const fingerprint = `${args.issue.id}:${Date.now()}`;
const reviewOutcome = await runReviewLoop(deps, args, {
  executor,
  primaryRunLog: loopResult.runLog,
  reviewerGlm,
  fingerprint,
  worktreePath,
});
if (reviewOutcome.kind === "escalated") {
  return { status: "agent_failed", branch, summary: loopResult.summary };
}
```

Add the helper function `runReviewLoop` at the bottom of code.ts:

```typescript
interface ReviewLoopCtx {
  executor: LocalExecutor;
  primaryRunLog: readonly import("../agent/loop.ts").RunLogEntry[];
  reviewerGlm: GLMClient;
  fingerprint: string;
  worktreePath: string;
}
type ReviewLoopOutcome = { kind: "approved"; verificationReport: string } | { kind: "escalated" };

async function runReviewLoop(
  deps: CodeHandlerDeps, args: CodeHandlerArgs, ctx: ReviewLoopCtx,
): Promise<ReviewLoopOutcome> {
  let round = 0;
  let previousFindings: readonly { title: string; detail: string; bugClass: string }[] = [];
  let lastRunLog = ctx.primaryRunLog;
  while (round < deps.review.maxRounds) {
    round++;
    const diff = await getDiff(ctx.worktreePath, BASE_BRANCH);
    const grepFn = async (pattern: string, glob?: string) => ctx.executor.grep(pattern, glob);
    const untested = await findUntestedExports({ diff, grep: grepFn });
    const unwired = await findUnwiredIdentifiers({ diff, grep: grepFn });
    const precheck = [...untested, ...unwired];
    const ticket = {
      identifier: args.issue.identifier, title: args.issue.title,
      description: args.issue.description ?? null,
    };
    let outcome = await runReviewer({
      db: deps.db, glm: ctx.reviewerGlm, executor: ctx.executor,
      ticket, issueLinearId: args.issue.id, fingerprint: ctx.fingerprint, round,
      diff, runLog: lastRunLog, precheckFindings: precheck, previousFindings,
      worktreePath: ctx.worktreePath,
      iterationCap: deps.review.iterationCap, timeoutMs: deps.review.timeoutMs,
    });
    if (outcome.kind === "failed") {
      log.warn("reviewer pass failed; retrying once", {
        issue: args.issue.identifier, round, reason: outcome.reason,
      });
      outcome = await runReviewer({
        db: deps.db, glm: ctx.reviewerGlm, executor: ctx.executor,
        ticket, issueLinearId: args.issue.id, fingerprint: ctx.fingerprint, round,
        diff, runLog: lastRunLog, precheckFindings: precheck, previousFindings,
        worktreePath: ctx.worktreePath,
        iterationCap: deps.review.iterationCap, timeoutMs: deps.review.timeoutMs,
      });
      if (outcome.kind === "failed") {
        recordEvent(deps.db, {
          eventType: "review_failed", ticketLinearId: args.issue.id,
          payload: { round, reason: outcome.reason },
        });
        return {
          kind: "approved",
          verificationReport: "_reviewer pass unavailable for this PR_",
        };
      }
    }
    recordEvent(deps.db, {
      eventType: "review_decision", ticketLinearId: args.issue.id,
      payload: {
        round, verdict: outcome.review.verdict,
        finding_count: outcome.review.findings.length,
      },
    });
    if (outcome.review.verdict === "approve") {
      return {
        kind: "approved",
        verificationReport: outcome.review.verificationReport.trim().length > 0
          ? outcome.review.verificationReport
          : "(no verification report — reviewer approved without findings)",
      };
    }
    if (round >= deps.review.maxRounds) {
      const body = synthesizeReviewRejectedBody({
        finalFindings: outcome.review.findings.map((f) => ({
          title: f.title, bugClass: f.bugClass,
        })),
      });
      try { await deps.linear.postComment(args.issue.id, body); }
      catch (err) {
        log.warn("could not post review-rejected escalation comment", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await reassignToReporter(deps, args);
      setTerminalState(deps.db, args.issue.id, "escalated");
      return { kind: "escalated" };
    }
    const fixupTask = renderReviewerFixupTask(outcome.review.findings);
    const primarySystem = composeSystemPrompt({ taskInstructions: CODE_TASK_INSTRUCTIONS });
    const fixup = await runAgentLoop({
      glm: deps.glm, executor: ctx.executor, systemPrompt: primarySystem,
      task: fixupTask, maxIterations: FIXUP_MAX_ITERATIONS,
      timeoutMs: deps.agentLoopTimeoutMs, temperature: 0.3,
      linear: deps.linear, github: deps.github, defaultRepo: args.repo,
      finishGateCommand: CHECK_COMMAND,
      ...(deps.cloudflare ? { cloudflare: deps.cloudflare } : {}),
    });
    log.info("reviewer-driven fixup loop done", {
      issue: args.issue.identifier, round,
      status: fixup.status, iterations: fixup.iterations,
    });
    lastRunLog = fixup.runLog;
    previousFindings = outcome.review.findings.map((f) => ({
      title: f.title, detail: f.detail, bugClass: f.bugClass,
    }));
    const checkOk = await ensurePostFinishCheckPasses(deps, args, {
      executor: ctx.executor, system: primarySystem,
    });
    if (!checkOk) return { kind: "escalated" };
  }
  return { kind: "escalated" };
}

function renderReviewerFixupTask(
  findings: readonly { title: string; detail: string; bugClass: string }[],
): string {
  const lines = [
    "A reviewer agent looked at your work and found blocking issues. Fix each one, commit, then call finish() again.",
    "",
    "Rules:",
    `- Run \`${CHECK_COMMAND}\` before finish.`,
    "- Address each finding directly. If you disagree with one, fix it anyway and explain in your finish summary.",
    "- Don't refactor unrelated code.",
    "",
    "Findings:",
  ];
  for (const f of findings) {
    lines.push(`- [${f.bugClass}] ${f.title}`);
    lines.push(`  ${f.detail}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Pass `verificationReport` to the PR body composer**

Update `ComposePrBodyArgs` to include `verificationReport: string`. Append to the user message inside `composePrBody`:

```typescript
"",
"Verification (from reviewer pass — append this verbatim as the ## Verification section):",
args.verificationReport,
```

Update `PR_BODY_TASK_INSTRUCTIONS` to require a `## Verification` section between "Things i'm less sure about" and "Test plan". Renumber sections accordingly.

At the call site in `runCodeHandler`, thread through:

```typescript
const prBody = await composePrBody(deps, {
  issue: args.issue, branch, summary: loopResult.summary,
  diff, commitLog: log_,
  verificationReport: reviewOutcome.verificationReport,
});
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: PASS — existing tests should still pass.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/code.ts src/index.ts
git commit -m "feat(code): wire reviewer pass into code handler"
```

---

## Task 12: PR body verification section + voice update

**Files:**
- Modify: `src/handlers/code.ts` (verify Task 11's prompt change)
- Modify: `voice.md` (add Verification section to PR body examples)

Mostly verification — Task 11 already wired the report. Make sure the prompt is clean and voice.md examples match.

- [ ] **Step 1: Re-read `PR_BODY_TASK_INSTRUCTIONS`**

Verify `## Verification` is required, ordered between "Things i'm less sure about" and "Test plan", and section numbering is consistent. Fix any issues inline.

- [ ] **Step 2: Update `voice.md`**

Locate examples 5 and 6 (PR body templates). Either add a note above them or amend each example to show a `## Verification` section. The body of the section is generated by the reviewer pass and pasted verbatim — primary doesn't write it. Restart needed for changes to take effect (voice.md is cached at module init).

- [ ] **Step 3: Run typecheck and tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/code.ts voice.md
git commit -m "docs(voice): document Verification section in PR body template"
```

---

## Task 13: Documentation updates

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the new env vars to `.env.example`**

Append:

```bash
# Reviewer pass: a fresh agent that reviews the primary's diff before
# push. Catches half-wired features, untested logic, and unverified
# claims. All optional.
GARY_REVIEWER_PROVIDER_ORDER=deepseek,z.ai,kimi
GARY_REVIEW_MAX_ROUNDS=3
GARY_REVIEW_ITERATION_CAP=15
GARY_REVIEW_TIMEOUT_MS=300000
```

- [ ] **Step 2: Add a Reviewer pass section + gotchas to `CLAUDE.md`**

Add a new section (after Architecture, or near Gotchas — fit existing structure):

```markdown
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
```

Add to Environment section: list the four new env vars.

Add to Gotchas:

```markdown
- **Reviewer agent's task arg is large**: includes diff (up to 30KB), run-log of every primary command, pre-check findings, and previous-round findings. Cache breakpoints land on the system prompt, tool list, and last user message — re-runs are cheap.
- **Run-log is captured but stdout is not**: `RunLogEntry` records command + exit + ts. The reviewer reasons about *whether* the primary ran a thing, not what it returned. Empty run-log on a non-trivial diff is a strong unverified-claim signal — reflected in the reviewer task render.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document reviewer pass env vars and architecture"
```

---

## Task 14: Manual smoke test

**Files:**
- Create: `scripts/probe-reviewer.ts`

Probe the reviewer in isolation against a fixture diff so we can verify before deploying. Mirrors the pattern of existing probe scripts.

- [ ] **Step 1: Write the probe script**

Create `scripts/probe-reviewer.ts`. Skeleton:

```typescript
// Smoke test the reviewer pass against a fixture diff. Non-destructive —
// makes one LLM call to the configured reviewer provider but writes
// nothing to Linear or GitHub. Logs verdict + findings to stdout.
//
// Usage:
//   bun run scripts/probe-reviewer.ts

import { LocalExecutor } from "../src/executors/local.ts";
import { loadConfig } from "../src/config.ts";
import { GLMClient } from "../src/adapters/glm.ts";
import { chainWithOrder, createProvider, createProviderChain } from "../src/providers.ts";
import { runReviewer } from "../src/review/runner.ts";
import { openDb } from "../src/state/db.ts";
import { findUntestedExports, findUnwiredIdentifiers } from "../src/review/precheck.ts";

const FIXTURE_DIFF = `diff --git a/src/lib/server/social.ts b/src/lib/server/social.ts
index 1111111..2222222 100644
--- a/src/lib/server/social.ts
+++ b/src/lib/server/social.ts
@@ -290,7 +290,7 @@ export async function feedTimeline(args: { userId: number; type: string; limit:
   const sql = \`SELECT p.* FROM posts p
       JOIN follows f ON f.following_id = p.author_id
      WHERE f.follower_id = ?1
-       AND p.created_at < ?2
+       AND p.type = ?2
      ORDER BY p.created_at DESC
      LIMIT ?2\`;
   return await db.prepare(sql).bind(args.userId, args.type, args.limit).all();
 }
`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(":memory:");
  db.query("INSERT INTO tickets (linear_id, identifier) VALUES ('probe-issue', 'PROBE-1')").run();
  const canonical = createProviderChain(cfg.providers.map((p) => createProvider(p)));
  const reviewerChain = chainWithOrder(canonical, cfg.review.providerOrder);
  const glm = new GLMClient(reviewerChain);

  const executor = new LocalExecutor(process.cwd());
  const grepFn = async (pat: string, glob?: string) => executor.grep(pat, glob);
  const untested = await findUntestedExports({ diff: FIXTURE_DIFF, grep: grepFn });
  const unwired = await findUnwiredIdentifiers({ diff: FIXTURE_DIFF, grep: grepFn });

  const result = await runReviewer({
    db, glm, executor,
    ticket: {
      identifier: "PROBE-1",
      title: "fix social timeline filter",
      description: "feed should filter by post type. SQL parameter index collides with LIMIT.",
    },
    issueLinearId: "probe-issue", fingerprint: "probe-fp", round: 1,
    diff: FIXTURE_DIFF, runLog: [],
    precheckFindings: [...untested, ...unwired],
    previousFindings: [], worktreePath: process.cwd(),
    iterationCap: cfg.review.iterationCap, timeoutMs: cfg.review.timeoutMs,
  });

  console.log("--- result ---");
  console.log(JSON.stringify(result, null, 2));
  console.log("--- pre-checks ---");
  console.log({ untested, unwired });
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the probe**

Run: `bun run scripts/probe-reviewer.ts`
Expected: Prints a verdict (likely `changes_needed` since the fixture has an obvious SQL parameter collision) and the pre-check findings.

- [ ] **Step 3: Commit and deploy**

```bash
git add scripts/probe-reviewer.ts
git commit -m "chore: add probe-reviewer smoke test script"
bun run deploy
```

Verify on the mini:

```bash
ssh mini 'tail -100 ~/Library/Logs/gary/stdout.log'
```

Look for `code handler starting`, `agent loop done`, then `reviewer pass` lines for the next CODE ticket. Watch for `review_failed` events; if rate is high, the reviewer prompt or model needs tuning.

---

## Self-Review Notes

Spec coverage check:

- **Architecture / loop budget / placement** → Tasks 9 + 11
- **Model selection** → Tasks 5 + 6 + 11
- **Prompt mandate / bug classes** → Task 8
- **Tool access / output schema** → Task 7
- **Pre-check (a) untested-export** → Task 3
- **Pre-check (b) unwired-identifier** → Task 4
- **Pre-check (c) run-log review** → Task 2 (capture) + Task 8 (rendering) + Task 9 (passing through)
- **Pre-check (d) tests pass** → Task 11 only reaches reviewer if existing `ensurePostFinishCheckPasses` passed; no new pre-check function needed
- **Run-log capture** → Task 2
- **PR body integration** → Tasks 11 + 12
- **Persistence (review_passes)** → Task 1
- **Escalation (review_rejected)** → Task 10
- **Configuration env vars** → Tasks 6 + 13
- **Failure modes / fail-open** → Task 11
- **Calibration via review_decision events + review_passes table** → Tasks 1 + 11

No placeholders, no TBD. Type names consistent across tasks: `ReviewVerdict`, `BugClass`, `ReviewFinding`, `SubmittedReview`, `ReviewerResult`, `RunLogEntry`, `PrecheckFinding`, `ReviewConfig`.
