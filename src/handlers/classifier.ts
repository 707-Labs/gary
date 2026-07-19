import { z } from "zod";
import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment } from "../adapters/linear.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import { log } from "../logger.ts";

export const CHANGE_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "perf",
] as const;

export const ClassificationSchema = z.object({
  classification: z.enum(["CODE", "ANSWER", "BOUNCE"]),
  confidence: z.number().min(0).max(1),
  scope: z.enum(["S", "M", "L"]),
  // Tolerant on purpose: a missing or out-of-vocabulary type degrades to
  // an unprefixed branch name, never to a failed classification.
  type: z.enum(CHANGE_TYPES).optional().catch(undefined),
  reasoning: z.string().min(1),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const TASK_INSTRUCTIONS = `You are classifying a Linear ticket assigned to you.

Output ONLY a single JSON object — no prose, no code fences, no preamble. The object must have:
{
  "classification": "CODE" | "ANSWER" | "BOUNCE",
  "confidence": <number from 0 to 1>,
  "scope": "S" | "M" | "L",
  "type": "feat" | "fix" | "refactor" | "chore" | "docs" | "test" | "perf",
  "reasoning": "<one or two sentences explaining your call, written in your voice>"
}

The "type" is the conventional-commit type of the change — it becomes the branch name prefix (e.g. fix/ert-1891-...). Bug reports are "fix", new behavior is "feat", and so on. For ANSWER or BOUNCE it's unused; pick your best guess anyway.

Definitions:
- CODE: writing code and opening a PR is the right response. Bug fixes, features, refactors, tests. Default here whenever a credible implementation path exists. A ticket that leaves design decisions to the implementer is CODE, not BOUNCE — making those calls is part of the job; pick the strongest approach and run with it.
- ANSWER: a question or clarification request you can answer without touching code.
- BOUNCE: you can't or shouldn't handle this. Context that's genuinely missing and not recoverable from the repo or thread; product calls that need human authority (pricing, deleting user data, cross-team commitments); anything requiring a D1 database migration (migrations don't run through the normal deploy and have broken prod before); a bug you have no path to reproducing.

Scope:
- S: a few lines or one file, ~30 min.
- M: a few files, < 2 hours, no architectural decisions.
- L: bigger than M — multi-file refactors, features with real design surface, work that may want a stacked PR series. L is the interesting work, not a warning label: if the logic is well-defined, take the swing. Size alone is never a reason to BOUNCE.

Honesty rules:
- BOUNCE for missing context or decisions above your pay grade — never for size, and never for design latitude you could exercise yourself.
- If confidence is below 0.5, prefer BOUNCE.
- If you BOUNCE, your reasoning must enumerate the open decisions as concrete options with a recommended default for each — "here are the decisions, pick one," not "sketch the behavior for me."
- Don't roleplay being "really good." Be calibrated.

Your reasoning will be used as part of a comment posted on the ticket, so write it in your own voice.`;

export interface ClassifyDeps {
  glm: GLMClient;
}

export interface ClassifyArgs {
  issue: AssignedIssue;
  comments: readonly IssueComment[];
}

export async function classifyTicket(
  deps: ClassifyDeps,
  args: ClassifyArgs,
): Promise<Classification> {
  const system = composeSystemPrompt({
    taskInstructions: TASK_INSTRUCTIONS,
  });
  const user = renderTicket(args.issue, args.comments);

  // K3 (main-work primary) spends output tokens on a thinking block before
  // the JSON lands — 2048 keeps the budget from being eaten by reasoning.
  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.1,
    maxTokens: 2048,
  });

  const parsed = parseClassification(raw);
  log.info("ticket classified", {
    identifier: args.issue.identifier,
    classification: parsed.classification,
    confidence: parsed.confidence,
    scope: parsed.scope,
  });
  return parsed;
}

function renderTicket(
  issue: AssignedIssue,
  comments: readonly IssueComment[],
): string {
  const sections: string[] = [];
  sections.push(`Ticket: ${issue.identifier} — ${issue.title}`);
  sections.push(`Team: ${issue.teamKey}`);
  sections.push(`State: ${issue.stateName}`);
  sections.push(`Reporter: ${issue.creatorName ?? "(unknown)"}`);
  sections.push("");
  sections.push("Description:");
  sections.push(issue.description ?? "(no description)");
  if (comments.length > 0) {
    sections.push("");
    sections.push(`Comments (${comments.length}, oldest first):`);
    const sorted = [...comments].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const c of sorted) {
      sections.push(`  ${c.userName ?? "?"} (${c.createdAt}): ${c.body}`);
    }
  }
  return sections.join("\n");
}

/**
 * Decide what happens after a classification lands. Returns a
 * post-classification routing decision the loop can act on without having
 * to re-derive the conditions.
 */
export type ClassifyOutcome =
  | { kind: "low_confidence" }
  | { kind: "proceed" };

export function decideClassifyOutcome(
  c: Classification,
  opts: { confidenceFloor?: number } = {},
): ClassifyOutcome {
  const floor = opts.confidenceFloor ?? 0.5;
  if (c.confidence < floor) return { kind: "low_confidence" };
  return { kind: "proceed" };
}

export function parseClassification(raw: string): Classification {
  const json = extractJson(raw);
  if (json === null) {
    throw new Error(
      `classifier output did not contain a JSON object: ${truncate(raw, 500)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `classifier output was not valid JSON: ${err instanceof Error ? err.message : String(err)} — body: ${truncate(json, 500)}`,
    );
  }
  return ClassificationSchema.parse(value);
}

/**
 * GLM sometimes wraps JSON in ```json fences, prefixes a sentence, or both.
 * Strip code fences and find the outermost balanced { ... } substring.
 */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced && fenced[1] ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const COMMENT_TASK_INSTRUCTIONS = `Write a short Linear comment announcing how you've classified this ticket. Reference voice.md examples 2 (CODE), 3 (ANSWER), and 4 (BOUNCE) — match the tone and length there.

Output the comment body as plain markdown text. No JSON, no preamble like "Here is the comment", no code fences. Just the comment.

Rules:
- One short paragraph, lowercase-friendly. (BOUNCE may add a numbered list below the paragraph — see below.)
- Don't repeat your reasoning verbatim — paraphrase if you need it at all.
- For CODE: say you're picking it up and you'll comment back when the PR is up.
- For ANSWER: give the actual answer using the reasoning.
- For BOUNCE: one short paragraph on what's blocking you and who you're bouncing to, then a numbered list of every open decision — each with 2-3 concrete options and your recommended default. The reader should be able to unblock you by replying "yes to all" or "2b, rest as recommended." Close by offering to take the swing once someone picks.`;

export interface ClassificationCommentArgs {
  issue: AssignedIssue;
  classification: Classification;
}

/** Voice-generated comment that announces the classification. */
export async function generateClassificationComment(
  deps: ClassifyDeps,
  args: ClassificationCommentArgs,
): Promise<string> {
  const system = composeSystemPrompt({
    taskInstructions: COMMENT_TASK_INSTRUCTIONS,
  });
  const user = [
    `Ticket: ${args.issue.identifier} — ${args.issue.title}`,
    `Reporter: ${args.issue.creatorName ?? "(unknown)"}`,
    "",
    `Classification: ${args.classification.classification}`,
    `Confidence: ${args.classification.confidence}`,
    `Scope: ${args.classification.scope}`,
    `Your reasoning (do not paste verbatim): ${args.classification.reasoning}`,
  ].join("\n");

  // 1024: room for K3's thinking block plus a BOUNCE decision list.
  const body = await deps.glm.complete({
    system,
    user,
    temperature: 0.4,
    maxTokens: 1024,
  });
  return body.trim();
}
