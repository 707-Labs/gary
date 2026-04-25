// Smoke test for the Linear adapter. Read-only — does not post comments
// or modify any tickets. Run with: bun run scripts/probe-linear.ts

import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadGaryConfig, loadLinearConfig } from "../src/config.ts";

const gary = loadGaryConfig();
const linear = loadLinearConfig();
const adapter = new LinearAdapter({ gary, linear });

const viewer = await adapter.getViewer();
console.log(`viewer:`);
console.log(`  id:          ${viewer.id}`);
console.log(`  name:        ${viewer.name}`);
console.log(`  displayName: ${viewer.displayName}`);
console.log(`  email:       ${viewer.email}`);

if (viewer.id !== gary.linearUserId) {
  console.error(
    `\n!! viewer.id (${viewer.id}) does not match GARY_LINEAR_USER_ID (${gary.linearUserId})`,
  );
  process.exit(1);
}
console.log(`  matches GARY_LINEAR_USER_ID ✓`);

console.log(`\nissues assigned to gary (non-terminal):`);
const issues = await adapter.fetchAssignedIssues();
if (issues.length === 0) {
  console.log("  (none)");
} else {
  for (const issue of issues) {
    console.log(
      `  ${issue.identifier}  ${issue.title}  [${issue.stateName} / ${issue.stateType}]  by ${issue.creatorName ?? "?"}`,
    );
    console.log(`    ${issue.url}`);
  }
}

console.log(`\nteam ID configured: ${linear.teamId}`);
console.log(`in-progress state: ${linear.inProgressStateId}`);
console.log(`\nprobe ok.`);
