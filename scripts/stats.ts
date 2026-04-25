// Provider/model quality rollup. Reads ~/.gary/state/gary.db locally and
// queries GitHub for live PR merge state. Intended as a quick snapshot, not a
// dashboard — re-run on the mini whenever you want a refreshed view.
//
// Usage: bun run scripts/stats.ts
//
// Notes on attribution:
// - PRs are attributed to the LATEST successful coding action's (provider,
//   model). Most tickets have a single start_coding row, but if a revisit
//   ever lands with a different model the latest one wins (it shaped the
//   final PR state).
// - "code-action success" means the coding handler returned without throwing,
//   not that the PR merged. The PR-level rollup is the quality signal.
// - PRs whose tickets have no recorded provider (pre-migration rows) are
//   bucketed as "unknown".

import { Database } from "bun:sqlite";
import { homedir } from "node:os";

import { makeGitHubClient } from "../src/adapters/github.ts";
import { loadGitHubConfig } from "../src/config.ts";

interface ActionRow {
  provider: string | null;
  model: string | null;
  action_type: string;
  success: number | null;
  ticket_linear_id: string;
  id: number;
}

interface PrRow {
  github_id: number;
  ticket_linear_id: string;
  repo: string;
  pr_number: number;
}

const dbPath = `${homedir()}/.gary/state/gary.db`;
const db = new Database(dbPath, { readonly: true, strict: true });

const actions = db
  .query<ActionRow, []>(
    `SELECT provider, model, action_type, success, ticket_linear_id, id
       FROM actions
      ORDER BY id ASC`,
  )
  .all();

console.log(`actions: ${actions.length} rows (${dbPath})`);

// Counts by (provider, model, action_type, success).
const actionRollup = new Map<
  string,
  { provider: string; model: string; action_type: string; total: number; succeeded: number }
>();
for (const a of actions) {
  const provider = a.provider ?? "unknown";
  const model = a.model ?? "unknown";
  const key = `${provider}|${model}|${a.action_type}`;
  const row = actionRollup.get(key) ?? {
    provider,
    model,
    action_type: a.action_type,
    total: 0,
    succeeded: 0,
  };
  row.total += 1;
  if (a.success === 1) row.succeeded += 1;
  actionRollup.set(key, row);
}

console.log("\n=== actions by (provider, model, action_type) ===");
console.table(
  Array.from(actionRollup.values()).sort((a, b) =>
    `${a.provider}${a.model}${a.action_type}` >
    `${b.provider}${b.model}${b.action_type}`
      ? 1
      : -1,
  ),
);

// Latest successful coding action per ticket → provider/model attribution.
const codingActions = actions.filter(
  (a) =>
    (a.action_type === "start_coding" || a.action_type === "revisit_code") &&
    a.success === 1,
);
const latestByTicket = new Map<string, ActionRow>();
for (const a of codingActions) {
  // actions sorted ASC by id, so the last write per ticket wins.
  latestByTicket.set(a.ticket_linear_id, a);
}

const prs = db
  .query<PrRow, []>(
    `SELECT github_id, ticket_linear_id, repo, pr_number FROM prs ORDER BY opened_at ASC`,
  )
  .all();

console.log(`\nfetching live state for ${prs.length} tracked PRs...`);
const github = makeGitHubClient(loadGitHubConfig());

interface PrState {
  number: number;
  repo: string;
  ticket: string;
  provider: string;
  model: string;
  state: "open" | "closed";
  merged: boolean;
}

const states: PrState[] = [];
for (const pr of prs) {
  const [owner, repo] = pr.repo.split("/") as [string, string];
  try {
    const live = await github.getPullRequest(owner, repo, pr.pr_number);
    const attribution = latestByTicket.get(pr.ticket_linear_id);
    states.push({
      number: pr.pr_number,
      repo: pr.repo,
      ticket: pr.ticket_linear_id,
      provider: attribution?.provider ?? "unknown",
      model: attribution?.model ?? "unknown",
      state: live.state,
      merged: live.merged,
    });
  } catch (err) {
    console.error(
      `  PR #${pr.pr_number} ${pr.repo}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const prRollup = new Map<
  string,
  {
    provider: string;
    model: string;
    open: number;
    merged: number;
    closed_unmerged: number;
    total: number;
  }
>();
for (const s of states) {
  const key = `${s.provider}|${s.model}`;
  const row = prRollup.get(key) ?? {
    provider: s.provider,
    model: s.model,
    open: 0,
    merged: 0,
    closed_unmerged: 0,
    total: 0,
  };
  row.total += 1;
  if (s.merged) row.merged += 1;
  else if (s.state === "closed") row.closed_unmerged += 1;
  else row.open += 1;
  prRollup.set(key, row);
}

const prRows = Array.from(prRollup.values()).map((r) => ({
  ...r,
  // Merge rate over RESOLVED PRs only (open ones are still in flight).
  resolved: r.merged + r.closed_unmerged,
  merge_pct:
    r.merged + r.closed_unmerged > 0
      ? `${Math.round((100 * r.merged) / (r.merged + r.closed_unmerged))}%`
      : "—",
}));

console.log("\n=== PRs by (provider, model) — live merge state ===");
console.table(prRows);

db.close();
