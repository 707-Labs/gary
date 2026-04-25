// One-off ops: reassign ERT-1651 from Gary back to Tanner before kicking the
// loop off, so Gary picks ERT-1615 / ERT-1613 / ERT-1610 instead.

import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadGaryConfig, loadLinearConfig } from "../src/config.ts";

const linear = new LinearAdapter({
  gary: loadGaryConfig(),
  linear: loadLinearConfig(),
});

const issues = await linear.fetchAssignedIssues();
const target = issues.find((i) => i.identifier === "ERT-1651");
if (!target) {
  console.error("ERT-1651 is not assigned to Gary anymore. Nothing to do.");
  process.exit(0);
}

// Tanner is the creator of ERT-1615 (per the description we read earlier).
const tannerSource = issues.find((i) => i.identifier === "ERT-1615");
if (!tannerSource?.creatorId) {
  console.error("could not infer Tanner's user ID from ERT-1615 creator");
  process.exit(1);
}
console.log(`Tanner user ID: ${tannerSource.creatorId} (${tannerSource.creatorName})`);

await linear.reassign(target.id, tannerSource.creatorId);
console.log(`reassigned ${target.identifier} to ${tannerSource.creatorName}`);
