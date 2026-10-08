// Operator-only admission. Reusing an ID never renews or raises its allowance.
// This does not assign issues or make model calls.
import { openSpendLedger } from "../src/spend.ts";

const [path, command, ...args] = process.argv.slice(2);
if (!path || !["enroll", "status", "close"].includes(command ?? "")) {
  throw new Error("usage: budget.ts <ledger-path> enroll <campaign> <campaign-USD> <ticket-id> <ticket-USD> [--draft] [--coding-reserve] | status <ticket-id> | close <ticket-id> <reason>");
}
function amount(raw: string | undefined): number {
  if (!raw || !/^\d+(?:\.\d{1,6})?$/.test(raw) || Number(raw) <= 0) throw new Error("USD amount must be positive, with at most six decimal places");
  return Number(raw);
}
const spend = openSpendLedger(path);
try {
  if (command === "enroll") {
    const [campaign, campaignCap, ticket, ticketCap, ...flags] = args;
    if (!campaign || !ticket || flags.some(f => !["--draft", "--coding-reserve"].includes(f)) || new Set(flags).size !== flags.length) throw new Error("invalid enrollment arguments");
    const campaignUsd = amount(campaignCap), ticketUsd = amount(ticketCap);
    spend.createCampaign(campaign, campaignUsd);
    spend.enrollTicket(campaign, ticket, ticketUsd, { draftPr: flags.includes("--draft"), codingReviewReserve: flags.includes("--coding-reserve") });
    console.log(JSON.stringify(spend.status(ticket), null, 2));
  } else {
    const [ticket, reason] = args;
    if (!ticket) throw new Error("ticket ID required");
    if (command === "close") {
      if (!reason) throw new Error("terminal reason required");
      spend.markTerminal(ticket, reason);
    }
    console.log(JSON.stringify(spend.status(ticket), null, 2));
  }
} finally { spend.close(); }
