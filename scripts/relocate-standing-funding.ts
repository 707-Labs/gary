// Relocate the standing engineering grant's budget aggregate to a new file.
// Dry run by default: prints every file and hash it would pin. --apply writes
// NEW files only (target dir, relocated config, old-aggregate tombstone lock)
// and refuses if anything is in flight. --enroll (separate run, after the new
// config is live in standing-engineering.env) enrolls the new pool in spend.db.
//
// usage:
//   bun scripts/relocate-standing-funding.ts --config <path> --config-sha256 <hex> \
//     --authority <path> --authority-sha256 <hex> --approval-evidence <file> \
//     [--target-dir <dir>] [--pool-id <id>] [--campaign-id <id>] [--apply]
//   bun scripts/relocate-standing-funding.ts --enroll --config <new> --config-sha256 <hex> \
//     --authority <path> --authority-sha256 <hex>
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createStandingEngineeringFundingGuard } from "../src/hermes/engineering-standing-funding.ts";
import { createStandingEngineeringBudget } from "../src/hermes/engineering-standing-budget.ts";
import { applyStandingRelocation, planStandingRelocation } from "../src/hermes/engineering-standing-relocation.ts";
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

if (flag("--enroll")) {
  fundingGuard(config)();
  const ledger = new SpendLedger(ledgerPath);
  try {
    const budget = createStandingEngineeringBudget({ ledger, authority: config.funding, assertAuthority: fundingGuard(config) });
    budget.enrollPool();
    console.log(JSON.stringify({ enrolled: budget.status() }, null, 2));
  } finally { ledger.close(); }
  process.exit(0);
}

// The current chain must verify before anything is derived from it.
fundingGuard(config)();
const evidencePath = required("--approval-evidence");
const evidence = lstatSync(evidencePath);
if (!evidence.isFile() || evidence.isSymbolicLink() || (evidence.mode & 0o077) !== 0) { console.error("approval evidence must be a private regular file"); process.exit(2); }
const approvalEvidenceSha256 = createHash("sha256").update(readFileSync(evidencePath)).digest("hex");
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const targetDirectory = value("--target-dir") ?? join(homedir(), ".gary/state/budget", "standing-" + stamp);
const journalDb = new Database(join(config.root, "engineering.sqlite"), { readonly: true, create: false });
const spendDb = new Database(ledgerPath, { readonly: true, create: false });
let plan: ReturnType<typeof planStandingRelocation>;
try {
  plan = planStandingRelocation({ config, configPath: required("--config"), journalDb, spendDb, ledgerPath,
    listLabelledContainers: dockerLabelledContainerLister(config.dockerExecutable, config.dockerSocketPath),
    approvalEvidenceSha256, targetDirectory, now: new Date(),
    next: { poolId: value("--pool-id") ?? `standing-engineering-coding-${stamp}-pool`, campaignId: value("--campaign-id") ?? `standing-engineering-coding-${stamp}-campaign` } });
} finally { journalDb.close(); spendDb.close(); }

console.log(JSON.stringify({
  mode: flag("--apply") ? "apply" : "dry-run",
  approvalEvidence: { path: evidencePath, sha256: approvalEvidenceSha256 },
  quiescence: plan.quiescence,
  retiredPool: { poolId: config.funding.poolId, capMicros: config.funding.capMicros, retainedMicros: plan.retainedMicros,
    transferredMicros: plan.authority.capMicros },
  newFunding: plan.authority,
  files: plan.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })),
  newConfig: { path: plan.newConfigPath, sha256: plan.newConfigSha256 },
  tombstone: plan.tombstonePath + "/transferred.json",
  envLines: [`GARY_STANDING_ENGINEERING_CONFIG=${plan.newConfigPath}`, `GARY_STANDING_ENGINEERING_CONFIG_SHA256=${plan.newConfigSha256}`,
    `GARY_STANDING_ENGINEERING_AUTHORITY=${required("--authority")}`, `GARY_STANDING_ENGINEERING_AUTHORITY_SHA256=${required("--authority-sha256")}`],
}, null, 2));
if (!flag("--apply")) process.exit(0);

applyStandingRelocation(plan, targetDirectory);
const moved = loadStandingEngineeringConfig(plan.newConfigPath, plan.newConfigSha256, required("--authority"), required("--authority-sha256"));
fundingGuard(moved)();
console.log("applied; new funding chain verifies. Next: update standing-engineering.env, then run --enroll with the new config.");
