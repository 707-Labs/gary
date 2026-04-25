// Print descriptions for tickets currently assigned to Gary, so we can
// eyeball the work before kicking him off. Read-only.

import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadGaryConfig, loadLinearConfig } from "../src/config.ts";

const adapter = new LinearAdapter({
  gary: loadGaryConfig(),
  linear: loadLinearConfig(),
});

const issues = await adapter.fetchAssignedIssues();
for (const issue of issues) {
  console.log(`=== ${issue.identifier} — ${issue.title} ===`);
  console.log(`state: ${issue.stateName} | reporter: ${issue.creatorName ?? "?"}`);
  console.log(`url: ${issue.url}`);
  console.log("");
  console.log(issue.description ?? "(no description)");
  const comments = await adapter.fetchComments(issue.id);
  if (comments.length > 0) {
    console.log(`\ncomments (${comments.length}):`);
    for (const c of comments) {
      console.log(`  ${c.userName ?? "?"} (${c.createdAt}):`);
      console.log(
        c.body
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }
  console.log("\n");
}
