// Smoke test for the Cloudflare adapter. Read-only.
// Verifies API token works, then runs a query against the production worker
// for the last 60 minutes (errors only) and prints a summary.
//
// Run with: bun run scripts/probe-cloudflare.ts

import { CloudflareClient } from "../src/adapters/cloudflare.ts";
import { loadCloudflareConfig } from "../src/config.ts";

const cfg = loadCloudflareConfig();
if (!cfg) {
  console.error(
    "cloudflare config missing — set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env",
  );
  process.exit(1);
}

console.log(`account: ${cfg.accountId}`);
console.log(`workers: ${cfg.observabilityWorkers.join(", ")}`);

const cf = new CloudflareClient(cfg);

const target = cfg.observabilityWorkers[0]!;

console.log(`\nlist keys (truncated)...`);
const keys = await cf.listKeys();
console.log(`  ${keys.length} keys total. first 10:`);
for (const k of keys.slice(0, 10)) {
  console.log(`    ${k.key} (${k.type})`);
}

console.log(`\nrecent invocations on ${target} (last 60m, errors only)...`);
const invs = await cf.listInvocations({
  service: target,
  errorsOnly: true,
  sinceMinutes: 60,
  limit: 10,
});
console.log(`  ${invs.length} matching invocations`);
for (const i of invs.slice(0, 5)) {
  console.log(
    `    ${new Date(i.timestamp).toISOString()} inv=${i.invocationId.slice(0, 8)} status=${i.status ?? "?"} dur=${i.durationMs ?? "?"}ms events=${i.events}`,
  );
}

console.log(`\nrecent error events on ${target} (last 60m)...`);
const events = await cf.queryLogs({
  service: target,
  errorsOnly: true,
  sinceMinutes: 60,
  limit: 5,
});
console.log(`  ${events.length} matching events`);
for (const e of events) {
  const t = new Date(e.timestamp).toISOString();
  const head = `    ${t} ${e.level ?? ""} inv=${(e.invocationId ?? "").slice(0, 8)}`;
  console.log(head);
  if (e.error) console.log(`      error: ${e.error.slice(0, 200)}`);
  if (e.message) console.log(`      ${e.message.slice(0, 200)}`);
}

console.log(`\nprobe ok.`);
