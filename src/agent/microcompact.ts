import type Anthropic from "@anthropic-ai/sdk";

/**
 * Microcompaction: replace older tool_result content from "noisy" tools
 * (read_file, grep, run_bash, etc.) with a short placeholder so long-running
 * agent loops don't hemorrhage input tokens on stale context.
 *
 * Inspired by Claude Code's microcompaction behavior: long sessions replace
 * stale tool results in place rather than re-summarizing the transcript.
 * Claude Code can also do this server-side via cache edits; Gary doesn't have
 * access to that API, so we mutate message content directly.
 *
 * Trade-off: each compaction event invalidates the prompt cache once. Subsequent
 * turns benefit from the smaller cached prefix until the next compaction. Pick
 * `every` large enough that the cache miss amortizes (default: every 6 turns,
 * starting after turn 12 — so first miss at turn 12, then at 18, 24, …).
 *
 * The compaction is deliberately conservative:
 *   - Only tool_results from `COMPACTABLE_TOOLS` are touched.
 *   - The most recent `keepRecent` compactable tool_results stay verbatim.
 *   - Already-cleared blocks are skipped (idempotent).
 */

export const TOOL_RESULT_CLEARED =
  "[old tool result cleared — re-run the tool if you need this content again]";

/**
 * Tools whose results are safe to clear. These are the "noisy" tools whose
 * outputs grow large but become stale quickly: file reads, search results,
 * shell output, etc. Excluded:
 *   - `write_file`, `edit_file`, `commit` — short confirmations, low value.
 *   - `todo_write`, `finish` — the model relies on these as anchors.
 *   - mutation tools (unassign_self, etc.) — short confirmations.
 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "list_files",
  "run_bash",
  "fetch_url",
  "get_linear_issue",
  "get_pr",
  "query_cloudflare_logs",
  "list_cloudflare_invocations",
  "d1_query",
]);

export interface MicrocompactOptions {
  /** Number of most recent compactable tool_results to leave untouched. */
  keepRecent: number;
}

export const DEFAULT_KEEP_RECENT = 6;

export interface MicrocompactResult {
  messages: Anthropic.MessageParam[];
  cleared: number;
  /**
   * Original read_file input paths whose contents were removed in this pass.
   * Callers must invalidate these using the same path normalization as their
   * read cache. A retained duplicate-read pointer does not preserve contents.
   */
  compactedReadPaths: string[];
}

/**
 * Returns a (possibly new) messages array with old compactable tool_results
 * cleared. Returns the input array unchanged if nothing was eligible.
 */
export function microcompactMessages(
  messages: readonly Anthropic.MessageParam[],
  options: MicrocompactOptions = { keepRecent: DEFAULT_KEEP_RECENT },
): MicrocompactResult {
  const compactableCalls = collectCompactableToolCalls(messages);
  const compactableIds = compactableCalls.map((call) => call.id);
  const readPathsById = new Map<string, string>();
  for (const call of compactableCalls) {
    if (call.name !== "read_file" || !call.input || typeof call.input !== "object") continue;
    const path = (call.input as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) readPathsById.set(call.id, path);
  }
  if (compactableIds.length === 0) {
    return { messages: [...messages], cleared: 0, compactedReadPaths: [] };
  }
  const keep = Math.max(1, options.keepRecent);
  const keepSet = new Set(compactableIds.slice(-keep));
  const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)));
  if (clearSet.size === 0) {
    return { messages: [...messages], cleared: 0, compactedReadPaths: [] };
  }

  let cleared = 0;
  const compactedReadPaths = new Set<string>();
  const out = messages.map((msg): Anthropic.MessageParam => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    let touched = false;
    const newContent = msg.content.map((block) => {
      if (
        block.type === "tool_result" &&
        clearSet.has(block.tool_use_id) &&
        !isAlreadyCleared(block)
      ) {
        touched = true;
        cleared += 1;
        const path = readPathsById.get(block.tool_use_id);
        if (path !== undefined && isReadFileContent(block, path)) {
          compactedReadPaths.add(path);
        }
        return { ...block, content: TOOL_RESULT_CLEARED };
      }
      return block;
    });
    if (!touched) return msg;
    return { ...msg, content: newContent };
  });

  return { messages: out, cleared, compactedReadPaths: [...compactedReadPaths] };
}

function collectCompactableToolCalls(
  messages: readonly Anthropic.MessageParam[],
): Anthropic.ToolUseBlock[] {
  const calls: Anthropic.ToolUseBlock[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && COMPACTABLE_TOOLS.has(block.name)) {
        calls.push(block);
      }
    }
  }
  return calls;
}

function isReadFileContent(block: Anthropic.ToolResultBlockParam, path: string): boolean {
  if (block.is_error || block.content === undefined) return false;
  if (typeof block.content !== "string") return block.content.length > 0;
  if (block.content.startsWith("error in read_file: ")) return false;
  // Match the tool's complete generated pointer, not an arbitrary file that
  // happens to contain the words "already read". Pointers cannot keep a read
  // cache entry valid after the original content has left the conversation.
  return block.content !==
    `(already read \`${path}\` earlier in this conversation; refer to your prior tool_result. write_file/edit_file on this path invalidates the cache and a fresh read returns updated content.)`;
}

function isAlreadyCleared(
  block: Anthropic.ToolResultBlockParam,
): boolean {
  return (
    typeof block.content === "string" && block.content === TOOL_RESULT_CLEARED
  );
}
