/**
 * Offline reproduction of the "pi emits zero output on the real coding task"
 * failure. Rebuilds the exact system prompt + project-context task that the
 * code handler feeds runPiLoop, points at a real ticket worktree, and runs pi
 * with GARY_PI_DEBUG_DIR set so raw stdout/stderr are captured to disk.
 *
 * Usage: bun run scripts/repro-pi.ts <WORKSPACE_DIR> <TASK_FILE>
 *   WORKSPACE_DIR: e.g. ~/.gary/workspaces/ERT-1907
 *   TASK_FILE:     markdown file with the ticket body (stands in for the
 *                  rendered Linear ticket)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { composeSystemPrompt } from "../src/agent/prompts.ts";
import { CODE_TASK_INSTRUCTIONS } from "../src/handlers/code.ts";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
  loadRuleDocs,
} from "../src/skills.ts";
import { runPiLoop } from "../src/agent/pi-loop.ts";

const workspaceDir = resolve(process.argv[2] ?? "");
const taskFile = process.argv[3];
if (!workspaceDir || !taskFile) {
  console.error("usage: bun run scripts/repro-pi.ts <WORKSPACE_DIR> <TASK_FILE>");
  process.exit(1);
}

const system = composeSystemPrompt({ taskInstructions: CODE_TASK_INSTRUCTIONS });
const projectSection = formatProjectContext(
  loadProjectContext(workspaceDir),
  loadSkillIndex(workspaceDir),
  loadRuleDocs(workspaceDir),
);
const ticketBody = readFileSync(taskFile, "utf8");
const taskMessage = projectSection ? `${projectSection}\n\n---\n\n${ticketBody}` : ticketBody;

console.error(
  `[repro] systemPrompt=${system.length}B projectSection=${projectSection.length}B ticketBody=${ticketBody.length}B taskMessage=${taskMessage.length}B`,
);
console.error(`[repro] cwd=${workspaceDir} debugDir=${process.env.GARY_PI_DEBUG_DIR}`);

const started = Date.now();
const result = await runPiLoop({
  worktreePath: workspaceDir,
  model: process.env.GARY_PI_MODEL ?? "openai-codex/gpt-5.6-sol",
  systemPrompt: system,
  task: taskMessage,
  timeoutMs: Number(process.env.REPRO_TIMEOUT_MS ?? 5 * 60_000),
  finishGateCommand: "bun run check",
});
console.error(`[repro] done in ${Math.round((Date.now() - started) / 1000)}s`);
console.error(JSON.stringify(result, null, 2));
