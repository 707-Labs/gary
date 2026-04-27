import { composeSystemPrompt } from "../agent/prompts.ts";
import type { RunLogEntry } from "../agent/loop.ts";
import type { PrecheckFinding } from "./precheck.ts";

export const REVIEW_TASK_INSTRUCTIONS = `You are reviewing another agent's diff. Your ONLY job is to find one concrete, blocking bug. If you can't find a real bug, approve. Default to approving — bias toward shipping when uncertain.

You have a tight iteration budget. Aim to call \`submit_review\` within 4-5 turns. If you haven't found a specific blocking bug after reading the diff and skimming the affected files, just approve.

A blocking finding MUST fall into one of these four classes:
- **wrong_code_path** — the code won't run, will throw, returns wrong values, has an off-by-one, or has a type mismatch the typechecker missed
- **unverified_claim** — the diff or commit message claims to have tested or verified something that the run-log shows was never executed
- **half_wired** — a new producer (query param, event, identifier) has no consumer somewhere in the codebase, or vice versa
- **untested_logic** — a changed exported function, SQL query, or component has no test that exercises the new behavior

DO NOT block on:
- style, formatting, or refactor opinions
- "could be cleaner" or "I would have done this differently"
- scope critiques ("this should be split into multiple PRs")
- documentation gaps that aren't directly mentioned in the ticket

Style/refactor/scope notes go in \`advisory_notes\` — never in \`findings\`.

Process:
1. Read the diff in full first. Most of the time the diff alone is enough to spot or rule out a bug.
2. Only if the diff is genuinely ambiguous: \`read_file\` one or two of the changed files for context. Don't read everything.
3. Glance at the run-log: did the primary execute the code paths it claims to have? Empty run-log + non-trivial diff = strong unverified_claim signal.
4. Use \`run_bash\` ONLY to run an existing test, query, or curl that directly verifies a specific bug hypothesis. Do NOT use \`run_bash\` to write throwaway analysis scripts (\`cat > /tmp/analyze.js << EOF\` and similar). If you find yourself writing a script to "analyze" the diff, stop — read the diff again instead, or just submit.
5. Call \`submit_review\` with your verdict. \`approve\` if no real bugs. \`changes_needed\` with non-empty \`findings\` only if you have a specific, defensible blocker. Always provide a \`verification_report\` describing what you actually checked.

Stay terse. The verification_report should fit in 4-8 bullets. Each finding's \`title\` is short (~70 chars); \`detail\` is one paragraph explaining what's wrong and how to verify it. When in doubt, approve — false-positive findings waste cycles and erode trust.`;

export function composeReviewerSystemPrompt(): string {
  return composeSystemPrompt({ taskInstructions: REVIEW_TASK_INSTRUCTIONS });
}

export interface ReviewTaskTicket {
  identifier: string;
  title: string;
  description: string | null;
}

export interface PreviousFinding {
  title: string;
  detail: string;
  bugClass: string;
}

export interface RenderReviewTaskArgs {
  ticket: ReviewTaskTicket;
  diff: string;
  runLog: readonly RunLogEntry[];
  precheckFindings: readonly PrecheckFinding[];
  previousFindings: readonly PreviousFinding[];
  worktreePath: string;
}

const DIFF_MAX_BYTES = 30_000;

export function renderReviewTask(args: RenderReviewTaskArgs): string {
  const sections: string[] = [];
  sections.push(`Worktree: ${args.worktreePath}`);
  sections.push("");
  sections.push(`Ticket: ${args.ticket.identifier} — ${args.ticket.title}`);
  sections.push("");
  sections.push("Description:");
  sections.push(args.ticket.description ?? "(no description)");
  sections.push("");
  sections.push("--- diff (under review) ---");
  const diff =
    args.diff.length > DIFF_MAX_BYTES
      ? args.diff.slice(0, DIFF_MAX_BYTES) + "\n... (diff truncated)"
      : args.diff;
  sections.push(diff);
  sections.push("");
  sections.push("--- run-log (commands the primary executed during its loop) ---");
  if (args.runLog.length === 0) {
    sections.push(
      "(empty — the primary did not run any shell commands. this is a strong signal for unverified_claim if the diff is non-trivial.)",
    );
  } else {
    for (const e of args.runLog) {
      sections.push(`exit=${e.exit}  ${e.cmd}`);
    }
  }
  sections.push("");
  sections.push("--- pre-check findings (deterministic, may have false positives) ---");
  if (args.precheckFindings.length === 0) {
    sections.push("(no pre-check findings)");
  } else {
    for (const f of args.precheckFindings) {
      sections.push(`- ${f.kind}: ${f.name} (in ${f.file})`);
    }
  }
  if (args.previousFindings.length > 0) {
    sections.push("");
    sections.push(
      "--- previous round findings (the primary attempted to fix these — verify they are addressed) ---",
    );
    for (const f of args.previousFindings) {
      sections.push(`- [${f.bugClass}] ${f.title}: ${f.detail}`);
    }
  }
  sections.push("");
  sections.push(
    "Do your review. Use read_file/grep/list_files/run_bash/fetch_url as needed. End by calling submit_review.",
  );
  return sections.join("\n");
}
