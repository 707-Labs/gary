import { z } from "zod";
import type { GLMClient } from "../adapters/glm.ts";
import type { AssignedIssue, IssueComment } from "../adapters/linear.ts";
import { composeSystemPrompt } from "../agent/prompts.ts";
import { log } from "../logger.ts";

export const ClassificationSchema = z.object({
  classification: z.enum(["CODE", "ANSWER", "BOUNCE"]),
  confidence: z.number().min(0).max(1),
  scope: z.enum(["S", "M", "L"]),
  reasoning: z.string().min(1),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const TASK_INSTRUCTIONS = `You are classifying a Linear ticket assigned to you.

Output ONLY a single JSON object — no prose, no code fences, no preamble. The object must have:
{
  "classification": "CODE" | "ANSWER" | "BOUNCE",
  "confidence": <number from 0 to 1>,
  "scope": "S" | "M" | "L",
  "reasoning": "<one or two sentences explaining your call, written in your voice>"
}

Definitions:
- CODE: writing code and opening a PR is the right response. Bug fixes, features, refactors, tests.
- ANSWER: a question or clarification request you can answer without touching code.
- BOUNCE: you can't or shouldn't handle this. Design decisions, ambiguous tickets, work needing context you don't have, anything touching production data, multi-week scope.

Scope:
- S: a few lines or one file, ~30 min.
- M: a few files, < 2 hours, no architectural decisions.
- L: bigger than M — multi-file refactors, large surface area, or work that may want a stacked PR series. L is fine if the logic is well-defined; size alone is not a reason to BOUNCE.

Honesty rules:
- BOUNCE for design ambiguity, missing context, or genuine inability to scope — not for size.
- If confidence is below 0.5, prefer BOUNCE.
- If the ticket is too vague to classify, BOUNCE with reasoning explaining what's missing.
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

  const raw = await deps.glm.complete({
    system,
    user,
    temperature: 0.1,
    maxTokens: 1024,
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
- One short paragraph, lowercase-friendly.
- Don't repeat your reasoning verbatim — paraphrase if you need it at all.
- For CODE: say you're picking it up and you'll comment back when the PR is up.
- For ANSWER: give the actual answer using the reasoning.
- For BOUNCE: explain what's making you bounce, who you're bouncing it back to, and offer to take another swing if there's more direction.`;

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

  const body = await deps.glm.complete({
    system,
    user,
    temperature: 0.4,
    maxTokens: 512,
  });
  return body.trim();
}
