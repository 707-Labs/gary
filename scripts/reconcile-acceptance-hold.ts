// Settle one engineering-acceptance hold in the budget aggregate: keep exactly its
// settled ledger charge, retire the rest, close its spend ticket. Dry run by default.
// --apply requires Gary stopped and writes: audit records, the closed ticket, and
// the aggregate (one entry changed, totals moved) under the shared admission lock.
//
// usage: bun scripts/reconcile-acceptance-hold.ts --aggregate <path> --hold-id <id>
//          [--ledger <spend.db>] [--audit-dir <dir>] [--journal <engineering.sqlite>]... [--apply]
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { reconcileEngineeringAcceptanceHold } from "../src/hermes/engineering-acceptance-reconciliation.ts";
import { assertGaryStopped, launchctlGaryService } from "../src/hermes/engineering-standing-relocation.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const values = (name: string) => args.flatMap((a, i) => a === name && args[i + 1] ? [args[i + 1]!] : []);
const required = (name: string) => value(name) ?? (console.error(`missing ${name}`), process.exit(2));

const state = join(homedir(), ".gary/state");
const engineeringRoots = readdirSync(state).filter(n => /^engineering-v\d+$/.test(n)).sort().map(n => join(state, n));
const journals = values("--journal").length ? values("--journal")
  : engineeringRoots.map(r => join(r, "engineering.sqlite")).filter(p => existsSync(p));
// Every continuation authority/claim is hashed into the evidence; closing the ticket is what stops them spending.
const continuationFiles = engineeringRoots.flatMap(r => [join(r, "continuation-authority.json"),
  ...(existsSync(join(r, "budget-admission")) ? readdirSync(join(r, "budget-admission")).filter(n => /continuation/.test(n)).map(n => join(r, "budget-admission", n)) : [])])
  .filter(p => existsSync(p));
const auditDir = value("--audit-dir") ?? join(state, "budget", "reconciliations");
if (flag("--apply")) { assertGaryStopped(launchctlGaryService); mkdirSync(dirname(auditDir), { recursive: true, mode: 0o700 }); }

const result = reconcileEngineeringAcceptanceHold({ aggregatePath: required("--aggregate"), holdId: required("--hold-id"),
  ledgerPath: value("--ledger") ?? join(state, "spend.db"), auditDir, journalPaths: journals, continuationFiles,
  apply: flag("--apply"), now: () => new Date() });
console.log(JSON.stringify({ mode: flag("--apply") ? "apply" : "dry-run", journals, continuationFiles, auditDir, ...result }, null, 2));
