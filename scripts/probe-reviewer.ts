// Smoke test the reviewer pass against a fixture diff. Non-destructive —
// makes one LLM call to the configured reviewer provider but writes
// nothing to Linear or GitHub. Logs the verdict + findings to stdout.
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
  // tickets row needs to exist for the FK on review_passes.
  db.query(
    "INSERT INTO tickets (linear_id, identifier) VALUES ('probe-issue', 'PROBE-1')",
  ).run();
  const canonical = createProviderChain(cfg.providers.map((p) => createProvider(p)));
  const reviewerChain = chainWithOrder(canonical, cfg.review.providerOrder);
  const glm = new GLMClient(reviewerChain);

  const executor = new LocalExecutor(process.cwd());
  const grepFn = async (pat: string, glob?: string) => executor.grep(pat, glob);
  const untested = await findUntestedExports({ diff: FIXTURE_DIFF, grep: grepFn });
  const unwired = await findUnwiredIdentifiers({ diff: FIXTURE_DIFF, grep: grepFn });

  const result = await runReviewer({
    db,
    glm,
    executor,
    ticket: {
      identifier: "PROBE-1",
      title: "fix social timeline filter",
      description: "feed should filter by post type. SQL parameter index collides with LIMIT.",
    },
    issueLinearId: "probe-issue",
    fingerprint: "probe-fp",
    round: 1,
    diff: FIXTURE_DIFF,
    runLog: [],
    precheckFindings: [...untested, ...unwired],
    previousFindings: [],
    worktreePath: process.cwd(),
    iterationCap: cfg.review.iterationCap,
    timeoutMs: cfg.review.timeoutMs,
  });

  console.log("--- result ---");
  console.log(JSON.stringify(result, null, 2));
  console.log("--- pre-checks ---");
  console.log({ untested, unwired });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
