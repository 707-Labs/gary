// Smoke test for the D1 query path. Read-only.
// Prints schema for the configured databases and runs a couple of trivial
// SELECTs to verify auth + the SELECT-only clamp.
//
// Run with: bun run scripts/probe-d1.ts

import { CloudflareClient } from "../src/adapters/cloudflare.ts";
import { loadCloudflareConfig } from "../src/config.ts";

const cfg = loadCloudflareConfig();
if (!cfg) {
  console.error(
    "cloudflare config missing — set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env",
  );
  process.exit(1);
}

const aliases = Object.keys(cfg.d1Databases);
if (aliases.length === 0) {
  console.error("no d1 databases configured");
  process.exit(1);
}

console.log(`account: ${cfg.accountId}`);
console.log(`databases: ${aliases.join(", ")}`);

const cf = new CloudflareClient(cfg);

for (const alias of aliases) {
  console.log(`\n--- ${alias} ---`);

  console.log(`tables:`);
  const tables = await cf.queryD1({
    database: alias,
    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  });
  for (const r of tables.rows) {
    console.log(`  ${r.name}`);
  }
  console.log(`  (${tables.rowsRead} rows read, ${tables.durationMs}ms)`);

  console.log(`select 1:`);
  const ping = await cf.queryD1({
    database: alias,
    sql: "SELECT 1 AS ok",
  });
  console.log(`  ${JSON.stringify(ping.rows[0])}`);
}

console.log(`\n--- write rejection sanity check ---`);
try {
  await cf.queryD1({
    database: aliases[0]!,
    sql: "DELETE FROM users",
  });
  console.error("FAIL: write was accepted");
  process.exit(2);
} catch (err) {
  console.log(`  blocked: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nprobe ok.`);
