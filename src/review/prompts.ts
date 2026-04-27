import { composeSystemPrompt } from "../agent/prompts.ts";
import type { RunLogEntry } from "../agent/loop.ts";
import type { PrecheckFinding } from "./precheck.ts";

export const REVIEW_TASK_INSTRUCTIONS = `You are reviewing another agent's diff for the same Linear ticket. Your ONLY job is to find concrete, blocking bugs. If you can't find a real bug, approve.

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
1. Read the diff in full. Then read the files it touches.
2. Look at the run-log: did the primary actually exercise the code paths it claims to have? If a fix changes SQL, did the primary run the query? If it changes a fetch path, did the primary fetch it?
3. Check pre-check findings: are they real (block) or false positives (mention in advisory_notes if worth noting)?
4. Use \`run_bash\` to verify anything you're unsure about. Run the failing test if there's one. Curl the asset. Query the fixture DB. Cheap empirical checks beat speculation.
5. Call \`submit_review\` with your verdict. \`approve\` if no real bugs. \`changes_needed\` with non-empty \`findings\` if you found a blocker. Always provide a \`verification_report\` describing what you checked — this gets appended to the PR body.

Stay terse. The verification_report should fit in 6-10 bullets. Each finding's \`title\` is short (~70 chars); \`detail\` is one paragraph explaining what's wrong and how to verify it.`;

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
