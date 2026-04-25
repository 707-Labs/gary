import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
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

/** Builds the toolset bound to an Executor. The agent loop drives this. */
export function makeToolset(executor: Executor): AgentTools {
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
