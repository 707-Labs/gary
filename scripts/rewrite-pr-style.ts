// One-off ops: regenerate the title and body for an open Gary PR using
// the new Claude-Code-style prompts. Updates the PR via `gh pr edit`.
//
// Usage: bun run scripts/rewrite-pr-style.ts <pr_number>

import { spawnSync } from "node:child_process";
import { GLMClient } from "../src/adapters/glm.ts";
import { LinearAdapter } from "../src/adapters/linear.ts";
import { composeSystemPrompt } from "../src/agent/prompts.ts";
import {
  loadGaryConfig,
  loadGLMConfig,
  loadLinearConfig,
} from "../src/config.ts";
import { getCommitLog, getDiff } from "../src/git.ts";
import {
  PR_BODY_TASK_INSTRUCTIONS,
  PR_TITLE_TASK_INSTRUCTIONS,
} from "../src/handlers/code.ts";

const prNumber = process.argv[2];
if (!prNumber) {
  console.error("usage: rewrite-pr-style.ts <pr_number>");
  process.exit(1);
}

const gary = loadGaryConfig();
const repo = gary.allowedRepos[0];
if (!repo) throw new Error("no allowed repos");

// Pull existing PR data to get the head branch.
const ghOut = spawnSync(
  "gh",
  [
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "headRefName,title,body",
  ],
  { encoding: "utf8" },
);
if (ghOut.status !== 0) {
  console.error(`gh pr view failed: ${ghOut.stderr}`);
  process.exit(1);
}
const pr = JSON.parse(ghOut.stdout) as {
  headRefName: string;
  title: string;
  body: string;
};
console.log(`PR #${prNumber}`);
console.log(`  head: ${pr.headRefName}`);
console.log(`  current title: ${pr.title}`);

// Branch name format: <TICKET>-<slug>. Pull the ticket id off the front.
const ticketMatch = pr.headRefName.match(/^([A-Z]+-\d+)/);
if (!ticketMatch?.[1]) {
  console.error(`could not extract ticket id from branch name ${pr.headRefName}`);
  process.exit(1);
}
const ticketId = ticketMatch[1];
console.log(`  ticket: ${ticketId}`);

// Find the worktree for this ticket.
const worktreePath = `${gary.workspacesDir}/${ticketId}`;
console.log(`  worktree: ${worktreePath}`);

// Fetch the issue from Linear so we can render the same prompt context the
// handler would have used.
const linear = new LinearAdapter({ gary, linear: loadLinearConfig() });
const allIssues = await linear.fetchAssignedIssues();
const issue = allIssues.find((i) => i.identifier === ticketId);
if (!issue) {
  console.error(
    `could not find ${ticketId} among Gary's currently assigned issues; the ticket may have been reassigned. Aborting to avoid using the wrong context.`,
  );
  process.exit(1);
}

// Diff and commit log.
const diff = await getDiff(worktreePath, "main");
const commitLog = await getCommitLog(worktreePath, "main");
console.log(`  diff length: ${diff.length} bytes`);
console.log(`  commits:\n${commitLog.split("\n").map((l) => "    " + l).join("\n")}`);

const glm = new GLMClient(loadGLMConfig());

const truncatedDiff =
  diff.length > 12_000 ? diff.slice(0, 12_000) + "\n... (diff truncated)" : diff;

const newBody = await glm.complete({
  system: composeSystemPrompt({ taskInstructions: PR_BODY_TASK_INSTRUCTIONS }),
  user: [
    `Ticket: ${issue.identifier} — ${issue.title}`,
    `Branch: ${pr.headRefName}`,
    `Your finish summary: (re-generating from existing PR; original summary unavailable)`,
    "",
    "Commits:",
    commitLog,
    "",
    "Diff:",
    truncatedDiff,
  ].join("\n"),
  temperature: 0.4,
  maxTokens: 1024,
});

const titleDiff =
  diff.length > 6000 ? diff.slice(0, 6000) + "\n... (truncated)" : diff;
const rawTitle = await glm.complete({
  system: composeSystemPrompt({ taskInstructions: PR_TITLE_TASK_INSTRUCTIONS }),
  user: [
    `Ticket: ${issue.identifier} — ${issue.title}`,
    `Your finish summary: (re-generating; original unavailable)`,
    "",
    "Diff (truncated):",
    titleDiff,
  ].join("\n"),
  temperature: 0.2,
  maxTokens: 128,
});
const newTitle = rawTitle.trim().split("\n")[0]?.trim() ?? issue.title;

console.log(`\n--- new title ---\n${newTitle}`);
console.log(`\n--- new body ---\n${newBody}`);

// Update the PR.
const editResult = spawnSync(
  "gh",
  [
    "pr",
    "edit",
    prNumber,
    "--repo",
    repo,
    "--title",
    newTitle,
    "--body",
    newBody,
  ],
  { encoding: "utf8" },
);
if (editResult.status !== 0) {
  console.error(`\ngh pr edit failed: ${editResult.stderr}`);
  process.exit(1);
}
console.log(`\n✓ PR #${prNumber} updated`);
