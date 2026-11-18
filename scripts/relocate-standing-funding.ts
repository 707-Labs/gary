// Relocate the standing engineering grant's budget aggregate to a new file.
// Dry run by default: prints quiescence, amounts, any blocking holds, and the
// approval-evidence template; with --approval-evidence it also prints every new
// file and hash. --apply writes NEW files only (target dir, relocated config,
// old-aggregate tombstone) and refuses while Gary runs or anything is in flight.
// --enroll (separate run, Gary stopped) retires the old pool and enrolls the new
// one in ONE spend.db transaction.
//
// usage:
//   bun scripts/relocate-standing-funding.ts --config <path> --config-sha256 <hex> \
//     --authority <path> --authority-sha256 <hex> [--approval-evidence <json>] \
//     [--target-dir <dir>] [--pool-id <id>] [--campaign-id <id>] [--apply]
//   bun scripts/relocate-standing-funding.ts --enroll --config <new> --config-sha256 <hex> \
//     --authority <path> --authority-sha256 <hex> --retired-config <old> --retired-config-sha256 <hex>
import { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createStandingEngineeringFundingGuard } from "../src/hermes/engineering-standing-funding.ts";
import { createStandingEngineeringBudget } from "../src/hermes/engineering-standing-budget.ts";
import { applyStandingRelocation, assertGaryStopped, inspectStandingRelocation, launchctlGaryService, planStandingRelocation } from "../src/hermes/engineering-standing-relocation.ts";
import { dockerLabelledContainerLister } from "../src/hermes/engineering-reboot-quiescence.ts";
import { loadStandingEngineeringConfig } from "../src/hermes/standing-engineering-config.ts";
import { SpendLedger } from "../src/spend.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const required = (name: string) => value(name) ?? (console.error(`missing ${name}`), process.exit(2));
const ledgerPath = resolve(homedir(), ".gary/state/spend.db");
const config = loadStandingEngineeringConfig(required("--config"), required("--config-sha256"), required("--authority"), required("--authority-sha256"));
const fundingGuard = (c: typeof config) => createStandingEngineeringFundingGuard({ authority: c.funding, fundingAuthorityPath: c.fundingAuthorityPath,
  fundingHoldReceiptPath: c.fundingHoldReceiptPath, aggregatePath: c.aggregatePath, ledgerPath });

const garyStopped = () => assertGaryStopped(launchctlGaryService);

if (flag("--enroll")) {
  garyStopped();
  fundingGuard(config)();
  const retired = loadStandingEngineeringConfig(required("--retired-config"), required("--retired-config-sha256"), required("--authority"), required("--authority-sha256"));
  const hold = JSON.parse(readFileSync(config.fundingHoldReceiptPath, "utf8"));
  const transfer = JSON.parse(readFileSync(hold.transfer.path, "utf8"));
  if (transfer.retiredAuthoritySha256 !== retired.funding.authoritySha256 || transfer.retiredHoldId !== "standing-engineering:" + retired.funding.poolId) {
    console.error("retired config does not match the transfer receipt"); process.exit(2);
  }
  const ledger = new SpendLedger(ledgerPath);
  try {
    const budget = createStandingEngineeringBudget({ ledger, authority: config.funding, assertAuthority: fundingGuard(config) });
    budget.enrollPoolReplacing({ retired: retired.funding, retainedMicros: transfer.retainedMicros, transferReceiptSha256: hold.transfer.sha256 });
    console.log(JSON.stringify({ retiredPool: retired.funding.poolId, retainedMicros: transfer.retainedMicros, enrolled: budget.status() }, null, 2));
  } finally { ledger.close(); }
  process.exit(0);
}

// The current chain must verify before anything is derived from it.
fundingGuard(config)();
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const targetDirectory = value("--target-dir") ?? join(homedir(), ".gary/state/budget", "standing-" + stamp);
const next = { poolId: value("--pool-id") ?? `standing-engineering-coding-${stamp}-pool`, campaignId: value("--campaign-id") ?? `standing-engineering-coding-${stamp}-campaign` };
const listLabelledContainers = dockerLabelledContainerLister(config.dockerExecutable, config.dockerSocketPath);
const evidencePath = value("--approval-evidence");
if (flag("--apply")) { garyStopped(); if (!evidencePath) { console.error("--apply requires --approval-evidence"); process.exit(2); } }
const journalDb = new Database(join(config.root, "engineering.sqlite"), { readonly: true, create: false });
const spendDb = new Database(ledgerPath, { readonly: true, create: false });
let report: Record<string, unknown>, plan: ReturnType<typeof planStandingRelocation> | undefined;
try {
  const inspection = inspectStandingRelocation({ config, journalDb, spendDb, listLabelledContainers, next });
  report = { mode: flag("--apply") ? "apply" : "dry-run", ...inspection };
  if (evidencePath) {
    const evidence = lstatSync(evidencePath);
    if (!evidence.isFile() || evidence.isSymbolicLink() || (evidence.mode & 0o077) !== 0) { console.error("approval evidence must be a private regular file"); process.exit(2); }
    plan = planStandingRelocation({ config, configPath: required("--config"), journalDb, spendDb, ledgerPath, listLabelledContainers,
      approvalEvidenceBytes: readFileSync(evidencePath), targetDirectory, now: new Date(), next });
    report = { ...report, newFunding: plan.authority, files: plan.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })),
      newConfig: { path: plan.newConfigPath, sha256: plan.newConfigSha256 }, tombstone: plan.tombstonePath + "/transferred.json",
      envLines: [`GARY_STANDING_ENGINEERING_CONFIG=${plan.newConfigPath}`, `GARY_STANDING_ENGINEERING_CONFIG_SHA256=${plan.newConfigSha256}`,
        `GARY_STANDING_ENGINEERING_AUTHORITY=${required("--authority")}`, `GARY_STANDING_ENGINEERING_AUTHORITY_SHA256=${required("--authority-sha256")}`] };
  }
} finally { journalDb.close(); spendDb.close(); }
console.log(JSON.stringify(report, null, 2));
if (!flag("--apply") || !plan) process.exit(0);

applyStandingRelocation(plan, targetDirectory);
const moved = loadStandingEngineeringConfig(plan.newConfigPath, plan.newConfigSha256, required("--authority"), required("--authority-sha256"));
fundingGuard(moved)();
try { fundingGuard(config)(); console.error("old grant still verifies; tombstone missing"); process.exit(1); } catch { /* expected: old grant now refuses */ }
console.log("applied; new chain verifies and the old grant refuses. Next: update standing-engineering.env, then --enroll (Gary stopped).");
