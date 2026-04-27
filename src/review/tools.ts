import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Executor } from "../executors/index.ts";
import type { RunLogEntry } from "../agent/loop.ts";
import { redactGitHubTokens } from "../redact.ts";

export type BugClass =
  | "wrong_code_path"
  | "unverified_claim"
  | "half_wired"
  | "untested_logic";

export interface ReviewFinding {
  title: string;
  detail: string;
  location?: { file: string; line?: number | undefined };
  bugClass: BugClass;
}

export type ReviewVerdict = "approve" | "changes_needed";

export interface SubmittedReview {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  advisoryNotes: string[];
  verificationReport: string;
}

export interface ReviewerTools {
  definitions: Anthropic.Tool[];
  handlers: Record<string, ReviewerToolHandler>;
  review: SubmittedReview | null;
  runLog: RunLogEntry[];
  readCache: Set<string>;
}

export interface ReviewerToolHandler {
  definition: Anthropic.Tool;
  run(input: unknown): Promise<string>;
}

export interface MakeReviewerToolsetOptions {
  runLog?: RunLogEntry[];
}

export function makeReviewerToolset(
  executor: Executor,
  opts: MakeReviewerToolsetOptions = {},
): ReviewerTools {
  const out: ReviewerTools = {
    definitions: [],
    handlers: {},
    review: null,
    runLog: opts.runLog ?? [],
    readCache: new Set<string>(),
  };
  const register = (h: ReviewerToolHandler): void => {
    out.definitions.push(h.definition);
    out.handlers[h.definition.name] = h;
  };
  register(readFileTool(executor, out));
  register(grepTool(executor));
  register(listFilesTool(executor));
  register(runBashTool(executor, out));
  register(fetchUrlTool());
  register(submitReviewTool(out));
  return out;
}

const readFileSchema = z.object({ path: z.string().min(1) });
function readFileTool(executor: Executor, tools: ReviewerTools): ReviewerToolHandler {
  return {
    definition: {
      name: "read_file",
      description:
        "Read the contents of a file in the workspace. Repeat reads of the same path return a short pointer.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async run(input) {
      const { path } = readFileSchema.parse(input);
      if (tools.readCache.has(path)) {
        return `(already read \`${path}\` earlier; refer to your prior tool_result.)`;
      }
      try {
        const content = await executor.readFile(path);
        tools.readCache.add(path);
        return content;
      } catch (err) {
        return formatError("read_file", err);
      }
    },
  };
}

const grepSchema = z.object({
  pattern: z.string().min(1),
  path_glob: z.string().optional(),
});
function grepTool(executor: Executor): ReviewerToolHandler {
  return {
    definition: {
      name: "grep",
      description:
        "Search file contents for a regular expression. Returns matches with file path and line number.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path_glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    async run(input) {
      const args = grepSchema.parse(input);
      try {
        const matches = await executor.grep(args.pattern, args.path_glob);
        if (matches.length === 0) return "(no matches)";
        const limited = matches.slice(0, 100);
        const more =
          matches.length > limited.length
            ? `\n... ${matches.length - limited.length} more`
            : "";
        return (
          limited.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") + more
        );
      } catch (err) {
        return formatError("grep", err);
      }
    },
  };
}

const listFilesSchema = z.object({ path_glob: z.string().min(1) });
function listFilesTool(executor: Executor): ReviewerToolHandler {
  return {
    definition: {
      name: "list_files",
      description: "List files matching a glob pattern.",
      input_schema: {
        type: "object",
        properties: { path_glob: { type: "string" } },
        required: ["path_glob"],
      },
    },
    async run(input) {
      const { path_glob } = listFilesSchema.parse(input);
      try {
        const files = await executor.listFiles(path_glob);
        if (files.length === 0) return "(no files)";
        return files.slice(0, 200).join("\n");
      } catch (err) {
        return formatError("list_files", err);
      }
    },
  };
}

const runBashSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().positive().optional(),
});
function runBashTool(executor: Executor, tools: ReviewerTools): ReviewerToolHandler {
  return {
    definition: {
      name: "run_bash",
      description:
        "Run a bash command in the workspace root. Use to verify claims empirically — run a test, curl an asset, query a fixture DB.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "number" },
        },
        required: ["command"],
      },
    },
    async run(input) {
      const args = runBashSchema.parse(input);
      const opts =
        args.timeout_seconds !== undefined
          ? { timeoutMs: args.timeout_seconds * 1000 }
          : {};
      try {
        const r = await executor.run(args.command, opts);
        tools.runLog.push({
          cmd: redactGitHubTokens(args.command),
          exit: r.exitCode,
          ts: Date.now(),
        });
        const parts = [
          `exit_code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`,
        ];
        if (r.stdout) parts.push(`--- stdout ---\n${truncate(r.stdout, 4000)}`);
        if (r.stderr) parts.push(`--- stderr ---\n${truncate(r.stderr, 4000)}`);
        return parts.join("\n");
      } catch (err) {
        return formatError("run_bash", err);
      }
    },
  };
}

const fetchUrlSchema = z.object({ url: z.string().url() });
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 200_000;
function fetchUrlTool(): ReviewerToolHandler {
  return {
    definition: {
      name: "fetch_url",
      description:
        "GET an http(s) URL and return the response body. Truncates large responses.",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    async run(input) {
      const { url } = fetchUrlSchema.parse(input);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return "error: invalid url";
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `error: only http(s) urls are allowed (got ${parsed.protocol})`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "gary-707-labs (https://github.com/707-Labs/gary)",
          },
          redirect: "follow",
          signal: controller.signal,
        });
        const text = await res.text();
        const body =
          text.length > FETCH_MAX_BYTES ? text.slice(0, FETCH_MAX_BYTES) : text;
        return `status: ${res.status}\ncontent-type: ${res.headers.get("content-type") ?? ""}\nbytes: ${text.length}\n\n${body}`;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return `error: fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
        }
        return formatError("fetch_url", err);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const submitReviewSchema = z.object({
  verdict: z.enum(["approve", "changes_needed"]),
  findings: z.array(
    z.object({
      title: z.string().min(1),
      detail: z.string().min(1),
      location: z
        .object({
          file: z.string().min(1),
          line: z.number().int().positive().optional(),
        })
        .optional(),
      bug_class: z.enum([
        "wrong_code_path",
        "unverified_claim",
        "half_wired",
        "untested_logic",
      ]),
    }),
  ),
  advisory_notes: z.array(z.string()),
  verification_report: z.string(),
});

function submitReviewTool(tools: ReviewerTools): ReviewerToolHandler {
  return {
    definition: {
      name: "submit_review",
      description:
        "Submit your review verdict. Pass `approve` if you can't find a real bug. Pass `changes_needed` ONLY for blocking bugs (wrong code path, unverified claim, half-wired feature, untested changed logic). Style and refactor opinions go in advisory_notes, never in findings. After calling this, the loop exits.",
      input_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approve", "changes_needed"] },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                detail: { type: "string" },
                location: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    line: { type: "number" },
                  },
                  required: ["file"],
                },
                bug_class: {
                  type: "string",
                  enum: [
                    "wrong_code_path",
                    "unverified_claim",
                    "half_wired",
                    "untested_logic",
                  ],
                },
              },
              required: ["title", "detail", "bug_class"],
            },
          },
          advisory_notes: { type: "array", items: { type: "string" } },
          verification_report: { type: "string" },
        },
        required: ["verdict", "findings", "advisory_notes", "verification_report"],
      },
    },
    async run(input) {
      const parsed = submitReviewSchema.parse(input);
      if (parsed.verdict === "changes_needed" && parsed.findings.length === 0) {
        return "error: changes_needed verdict requires at least one finding (non-empty findings array)";
      }
      if (parsed.verdict === "approve" && parsed.findings.length > 0) {
        return "error: cannot approve with findings — either drop them to advisory_notes or change verdict to changes_needed";
      }
      tools.review = {
        verdict: parsed.verdict,
        findings: parsed.findings.map((f) => ({
          title: f.title,
          detail: f.detail,
          ...(f.location ? { location: f.location } : {}),
          bugClass: f.bug_class,
        })),
        advisoryNotes: parsed.advisory_notes,
        verificationReport: parsed.verification_report,
      };
      return "review submitted";
    },
  };
}

function formatError(toolName: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `error in ${toolName}: ${msg}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
