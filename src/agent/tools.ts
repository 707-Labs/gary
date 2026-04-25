import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { CloudflareClient } from "../adapters/cloudflare.ts";
import type { GitHubClient } from "../adapters/github.ts";
import type { LinearAdapter } from "../adapters/linear.ts";
import type { Executor } from "../executors/index.ts";

export interface ToolHandler {
  definition: Anthropic.Tool;
  run(input: unknown): Promise<string>;
}

export interface AgentTools {
  /** Tool definitions, in the order they should be advertised to the model. */
  definitions: Anthropic.Tool[];
  /** Tool name → handler. */
  handlers: Record<string, ToolHandler>;
  /** Set when the agent calls finish. */
  finishSummary: string | null;
}

export interface ToolsetOptions {
  /** When set, exposes Cloudflare Workers Observability tools. */
  cloudflare?: CloudflareClient;
  /** When set, exposes Linear read tools (e.g. `get_linear_issue`). */
  linear?: LinearAdapter;
  /** When set, exposes GitHub read tools (e.g. `get_pr`). */
  github?: GitHubClient;
  /** "owner/repo" used as the default for github tools when omitted. */
  defaultRepo?: string;
}

/** Builds the toolset bound to an Executor. The agent loop drives this. */
export function makeToolset(executor: Executor, opts: ToolsetOptions = {}): AgentTools {
  const out: AgentTools = {
    definitions: [],
    handlers: {},
    finishSummary: null,
  };

  const register = (handler: ToolHandler): void => {
    out.definitions.push(handler.definition);
    out.handlers[handler.definition.name] = handler;
  };

  register(readFileTool(executor));
  register(writeFileTool(executor));
  register(editFileTool(executor));
  register(grepTool(executor));
  register(listFilesTool(executor));
  register(runBashTool(executor));
  register(commitTool(executor));
  register(fetchUrlTool());
  if (opts.linear) {
    register(getLinearIssueTool(opts.linear));
  }
  if (opts.github) {
    register(getPrTool(opts.github, opts.defaultRepo));
  }
  if (opts.cloudflare) {
    register(queryCloudflareLogsTool(opts.cloudflare));
    register(listCloudflareInvocationsTool(opts.cloudflare));
    register(d1QueryTool(opts.cloudflare));
  }
  register(finishTool(out));

  return out;
}

const readFileSchema = z.object({ path: z.string().min(1) });
function readFileTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "read_file",
      description: "Read the contents of a file in the workspace.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace root." } },
        required: ["path"],
      },
    },
    async run(input) {
      const { path } = readFileSchema.parse(input);
      try {
        return await executor.readFile(path);
      } catch (err) {
        return formatError("read_file", err);
      }
    },
  };
}

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
function writeFileTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "write_file",
      description:
        "Write content to a file (creates or overwrites). Use edit_file for surgical changes.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    async run(input) {
      const { path, content } = writeFileSchema.parse(input);
      try {
        await executor.writeFile(path, content);
        return `wrote ${path} (${content.length} bytes)`;
      } catch (err) {
        return formatError("write_file", err);
      }
    },
  };
}

const editFileSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
});
function editFileTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "edit_file",
      description:
        "Replace exactly one occurrence of old_string with new_string in the file. Fails if old_string is missing or appears multiple times — provide more context to make it unique.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    async run(input) {
      const { path, old_string, new_string } = editFileSchema.parse(input);
      try {
        const content = await executor.readFile(path);
        const occurrences = countOccurrences(content, old_string);
        if (occurrences === 0) {
          return `error: old_string not found in ${path}`;
        }
        if (occurrences > 1) {
          return `error: old_string matches ${occurrences} times in ${path}; provide more surrounding context to make it unique`;
        }
        const updated = content.replace(old_string, new_string);
        await executor.writeFile(path, updated);
        return `edited ${path}`;
      } catch (err) {
        return formatError("edit_file", err);
      }
    },
  };
}

const grepSchema = z.object({
  pattern: z.string().min(1),
  path_glob: z.string().optional(),
});
function grepTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "grep",
      description:
        "Search file contents for a regular expression. Returns matches with file path and line number.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path_glob: {
            type: "string",
            description: "Glob to limit search, e.g. 'src/**/*.ts'. Defaults to all files.",
          },
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
        const more = matches.length > limited.length
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
function listFilesTool(executor: Executor): ToolHandler {
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
        const limited = files.slice(0, 200);
        const more = files.length > limited.length
          ? `\n... ${files.length - limited.length} more`
          : "";
        return limited.join("\n") + more;
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
function runBashTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "run_bash",
      description:
        "Run a bash command in the workspace root. Use for builds, tests, git status, anything that's not a file read/write.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: {
            type: "number",
            description: "Optional timeout in seconds. Default 120s.",
          },
        },
        required: ["command"],
      },
    },
    async run(input) {
      const args = runBashSchema.parse(input);
      const opts = args.timeout_seconds !== undefined
        ? { timeoutMs: args.timeout_seconds * 1000 }
        : {};
      try {
        const r = await executor.run(args.command, opts);
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

const commitSchema = z.object({ message: z.string().min(1) });
function commitTool(executor: Executor): ToolHandler {
  return {
    definition: {
      name: "commit",
      description:
        "Stage all changes (git add -A) and create a commit with the given message. Author/email are configured by the handler that started this loop.",
      input_schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    async run(input) {
      const { message } = commitSchema.parse(input);
      try {
        // Use stdin to pass the commit message — avoids shell-escaping issues
        // with quotes/backticks in voice-generated commit bodies.
        const escaped = message.replace(/'/g, "'\\''");
        const r = await executor.run(
          `git add -A && printf '%s' '${escaped}' | git commit --no-gpg-sign -F -`,
        );
        if (r.exitCode !== 0) {
          return `commit failed (exit ${r.exitCode})\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
        }
        return `committed.\n${r.stdout.trim()}`;
      } catch (err) {
        return formatError("commit", err);
      }
    },
  };
}

const finishSchema = z.object({ summary: z.string().min(1) });
function finishTool(out: AgentTools): ToolHandler {
  return {
    definition: {
      name: "finish",
      description:
        "Signal you're done. Provide a one-sentence summary of what you did. After calling this, the loop exits.",
      input_schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
    async run(input) {
      const { summary } = finishSchema.parse(input);
      out.finishSummary = summary;
      return "finished";
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function formatError(toolName: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `error in ${toolName}: ${msg}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const fetchUrlSchema = z.object({
  url: z.string().url(),
});
const FETCH_URL_TIMEOUT_MS = 30_000;
const FETCH_URL_MAX_BYTES = 200_000;
function fetchUrlTool(): ToolHandler {
  return {
    definition: {
      name: "fetch_url",
      description:
        "GET an http(s) URL and return the response body as text. Use for reading external docs, API specs, or anything the ticket links to. Truncates large responses.",
      input_schema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full http(s) URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
    async run(input) {
      const { url } = fetchUrlSchema.parse(input);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return `error: invalid url`;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `error: only http(s) urls are allowed (got ${parsed.protocol})`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_URL_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "gary-707-labs (https://github.com/707-Labs/gary)" },
          redirect: "follow",
          signal: controller.signal,
        });
        const text = await res.text();
        const truncated = text.length > FETCH_URL_MAX_BYTES;
        const body = truncated ? text.slice(0, FETCH_URL_MAX_BYTES) : text;
        const header = `status: ${res.status}\ncontent-type: ${res.headers.get("content-type") ?? ""}\nbytes: ${text.length}${truncated ? ` (truncated to ${FETCH_URL_MAX_BYTES})` : ""}`;
        return `${header}\n\n${body}`;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return `error: fetch timed out after ${FETCH_URL_TIMEOUT_MS / 1000}s`;
        }
        return formatError("fetch_url", err);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const getLinearIssueSchema = z.object({
  identifier: z.string().regex(/^[A-Z]+-\d+$/, "must be like ERT-1234"),
  include_comments: z.boolean().optional(),
});
function getLinearIssueTool(linear: LinearAdapter): ToolHandler {
  return {
    definition: {
      name: "get_linear_issue",
      description:
        "Fetch another Linear ticket by identifier (e.g. 'ERT-1500'). Returns title, status, description, and recent comments. Use when a ticket references another one ('duplicate of', 'follow-up to', 'see X for context').",
      input_schema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Linear ticket identifier like 'ERT-1500'.",
          },
          include_comments: {
            type: "boolean",
            description: "Include the most recent comments. Default true.",
          },
        },
        required: ["identifier"],
      },
    },
    async run(input) {
      const { identifier, include_comments } = getLinearIssueSchema.parse(input);
      try {
        const issue = await linear.fetchByIdentifier(identifier);
        if (!issue) return `no issue found for ${identifier}`;
        const lines = [
          `${issue.identifier}: ${issue.title}`,
          `state: ${issue.stateName} (${issue.stateType})`,
          `creator: ${issue.creatorName ?? "?"}`,
          `url: ${issue.url}`,
          `created: ${issue.createdAt}  updated: ${issue.updatedAt}`,
          "",
          "description:",
          issue.description ?? "(empty)",
        ];
        if (include_comments !== false) {
          const comments = await linear.fetchComments(issue.id, 10);
          lines.push("");
          lines.push(`comments (${comments.length}, oldest first):`);
          const sorted = [...comments].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          );
          for (const c of sorted) {
            lines.push(`  ${c.userName ?? "?"} (${c.createdAt}): ${truncate(c.body, 800)}`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        return formatError("get_linear_issue", err);
      }
    },
  };
}

const getPrSchema = z.object({
  number: z.number().int().positive(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/repo").optional(),
  include_diff: z.boolean().optional(),
});
const PR_DIFF_MAX_BYTES = 30_000;
const PR_BODY_MAX_BYTES = 4_000;
function getPrTool(github: GitHubClient, defaultRepo?: string): ToolHandler {
  return {
    definition: {
      name: "get_pr",
      description:
        "Fetch a GitHub pull request by number — title, body, base/head refs, and (optionally) the unified diff. Use when a ticket says 'see PR #260' or you want to align with prior work. Diff is truncated to ~30KB.",
      input_schema: {
        type: "object",
        properties: {
          number: { type: "number", description: "PR number." },
          repo: {
            type: "string",
            description: `Optional 'owner/repo'. Defaults to ${defaultRepo ?? "the configured repo"}.`,
          },
          include_diff: {
            type: "boolean",
            description: "Include the unified diff. Default true.",
          },
        },
        required: ["number"],
      },
    },
    async run(input) {
      const args = getPrSchema.parse(input);
      const repo = args.repo ?? defaultRepo;
      if (!repo) {
        return "error: no repo specified and no default configured";
      }
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const pr = await github.getPullRequestDetail(owner, name, args.number);
        const lines = [
          `${repo}#${pr.number}: ${pr.title}`,
          `state: ${pr.state}${pr.merged ? " (merged)" : ""}${pr.isDraft ? " (draft)" : ""}`,
          `base: ${pr.baseRef}  head: ${pr.headRef}  sha: ${pr.headSha}`,
          `url: ${pr.url}`,
          "",
          "body:",
          truncate(pr.body, PR_BODY_MAX_BYTES) || "(empty)",
        ];
        if (args.include_diff !== false) {
          const truncated = pr.diff.length > PR_DIFF_MAX_BYTES;
          const diff = truncated ? pr.diff.slice(0, PR_DIFF_MAX_BYTES) : pr.diff;
          lines.push("");
          lines.push(`diff (${pr.diff.length} bytes${truncated ? `, truncated to ${PR_DIFF_MAX_BYTES}` : ""}):`);
          lines.push(diff);
        }
        return lines.join("\n");
      } catch (err) {
        return formatError("get_pr", err);
      }
    },
  };
}

const queryLogsSchema = z.object({
  service: z.string().optional(),
  needle: z.string().optional(),
  errors_only: z.boolean().optional(),
  since_minutes: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
function queryCloudflareLogsTool(cf: CloudflareClient): ToolHandler {
  return {
    definition: {
      name: "query_cloudflare_logs",
      description:
        "Search Cloudflare Workers logs for the production app. Use this when a ticket references a runtime error, a specific user-facing failure, or asks to investigate an incident. Stack traces come back de-minified (source maps are uploaded). Returns one line per matching event.",
      input_schema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description:
              "Worker name to scope the search to (e.g. 'mulligan-labs', 'mulligan-labs-party'). Omit to search all production workers.",
          },
          needle: {
            type: "string",
            description:
              "Free-text substring to search for in event payloads (case-insensitive). Use this to find a specific error message, user id, or request path.",
          },
          errors_only: {
            type: "boolean",
            description:
              "Restrict to events with `$metadata.error` set. Default false.",
          },
          since_minutes: {
            type: "number",
            description:
              "Time window length ending now, in minutes. Default 60. Max 10080 (7 days).",
          },
          limit: {
            type: "number",
            description: "Max events to return. Default 50, max 200.",
          },
        },
      },
    },
    async run(input) {
      const parsed = queryLogsSchema.parse(input);
      try {
        const args: Parameters<typeof cf.queryLogs>[0] = {};
        if (parsed.service !== undefined) args.service = parsed.service;
        if (parsed.needle !== undefined) args.needle = parsed.needle;
        if (parsed.errors_only !== undefined) args.errorsOnly = parsed.errors_only;
        if (parsed.since_minutes !== undefined) args.sinceMinutes = parsed.since_minutes;
        if (parsed.limit !== undefined) args.limit = parsed.limit;
        const events = await cf.queryLogs(args);
        if (events.length === 0) return "no events matched";
        return events.map(formatLogEvent).join("\n\n");
      } catch (err) {
        return formatError("query_cloudflare_logs", err);
      }
    },
  };
}

const listInvocationsSchema = z.object({
  service: z.string().optional(),
  errors_only: z.boolean().optional(),
  since_minutes: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
function listCloudflareInvocationsTool(cf: CloudflareClient): ToolHandler {
  return {
    definition: {
      name: "list_cloudflare_invocations",
      description:
        "List recent invocations (requests/triggers) of a Cloudflare Worker, grouped by invocation id. Use this to find specific failing requests, then drill in with query_cloudflare_logs.",
      input_schema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description: "Worker name. Omit to span all production workers.",
          },
          errors_only: {
            type: "boolean",
            description: "Only invocations whose events include an error. Default false.",
          },
          since_minutes: {
            type: "number",
            description: "Time window in minutes. Default 60, max 10080.",
          },
          limit: {
            type: "number",
            description: "Max invocations. Default 50, max 200.",
          },
        },
      },
    },
    async run(input) {
      const parsed = listInvocationsSchema.parse(input);
      try {
        const args: Parameters<typeof cf.listInvocations>[0] = {};
        if (parsed.service !== undefined) args.service = parsed.service;
        if (parsed.errors_only !== undefined) args.errorsOnly = parsed.errors_only;
        if (parsed.since_minutes !== undefined) args.sinceMinutes = parsed.since_minutes;
        if (parsed.limit !== undefined) args.limit = parsed.limit;
        const invs = await cf.listInvocations(args);
        if (invs.length === 0) return "no invocations matched";
        return invs.map(formatInvocation).join("\n");
      } catch (err) {
        return formatError("list_cloudflare_invocations", err);
      }
    },
  };
}

const d1QuerySchema = z.object({
  database: z.string().min(1),
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
});
const D1_ROWS_MAX = 200;
function d1QueryTool(cf: CloudflareClient): ToolHandler {
  return {
    definition: {
      name: "d1_query",
      description:
        "Run a read-only SQL query against an Ertai D1 database. Use SELECT, WITH, EXPLAIN, or PRAGMA — write statements are rejected. Useful for inspecting schema (e.g. PRAGMA table_info(users)) and confirming production data shape when debugging a ticket.",
      input_schema: {
        type: "object",
        properties: {
          database: {
            type: "string",
            description: "Database alias (e.g. 'mulligan-labs').",
          },
          sql: {
            type: "string",
            description:
              "Single SQL statement. Must start with SELECT, WITH, EXPLAIN, or PRAGMA.",
          },
          params: {
            type: "array",
            description:
              "Bound parameters for the query (use ?1, ?2 placeholders in the SQL).",
            items: {},
          },
        },
        required: ["database", "sql"],
      },
    },
    async run(input) {
      const args = d1QuerySchema.parse(input);
      try {
        const result = await cf.queryD1({
          database: args.database,
          sql: args.sql,
          ...(args.params !== undefined ? { params: args.params } : {}),
        });
        const truncated = result.rows.length > D1_ROWS_MAX;
        const rows = truncated ? result.rows.slice(0, D1_ROWS_MAX) : result.rows;
        const meta = `rows: ${result.rows.length}${truncated ? ` (showing first ${D1_ROWS_MAX})` : ""} | rows_read: ${result.rowsRead} | duration: ${result.durationMs}ms`;
        if (rows.length === 0) return `${meta}\n(no rows)`;
        return `${meta}\n\n${JSON.stringify(rows, null, 2)}`;
      } catch (err) {
        return formatError("d1_query", err);
      }
    },
  };
}

function formatLogEvent(e: import("../adapters/cloudflare.ts").LogEvent): string {
  const t = new Date(e.timestamp).toISOString();
  const head = `${t} [${e.service}]${e.level ? ` ${e.level}` : ""}${e.invocationId ? ` inv=${e.invocationId.slice(0, 8)}` : ""}`;
  const lines = [head];
  if (e.error) lines.push(`error: ${truncate(e.error, 1500)}`);
  if (e.message) lines.push(truncate(e.message, 1500));
  return lines.join("\n");
}

function formatInvocation(i: import("../adapters/cloudflare.ts").InvocationSummary): string {
  const t = new Date(i.timestamp).toISOString();
  const parts = [
    t,
    `[${i.service}]`,
    `inv=${i.invocationId.slice(0, 8)}`,
    `events=${i.events}`,
  ];
  if (i.status !== null) parts.push(`status=${i.status}`);
  if (i.durationMs !== null) parts.push(`dur=${Math.round(i.durationMs)}ms`);
  if (i.hasError) parts.push("ERROR");
  return parts.join(" ");
}
