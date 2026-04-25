// Smoke test for the agent loop. Spins up a temp workspace, asks GLM to
// create a file via tools, and verifies the file landed and the loop
// terminated cleanly via `finish`.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLMClient } from "../src/adapters/glm.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { composeSystemPrompt } from "../src/agent/prompts.ts";
import { loadGLMChain } from "../src/config.ts";
import { LocalExecutor } from "../src/executors/local.ts";

const workspace = mkdtempSync(join(tmpdir(), "gary-probe-agent-"));
console.log(`workspace: ${workspace}`);

const glm = new GLMClient(loadGLMChain());
const executor = new LocalExecutor(workspace);

const system = composeSystemPrompt({
  taskInstructions:
    "You are picking up a Linear ticket. Use the tools to make the change, then call finish() with a one-sentence summary.",
});

const result = await runAgentLoop({
  glm,
  executor,
  systemPrompt: system,
  task: `Create a file called hello.txt in the workspace root containing the single word "hi" (no newline, no quotes). When done, call finish().`,
  maxIterations: 10,
  timeoutMs: 60_000,
  temperature: 0.1,
});

console.log("\nresult:", result);

let contents: string | null = null;
try {
  contents = readFileSync(join(workspace, "hello.txt"), "utf8");
} catch {
  // file missing
}
console.log(`hello.txt contents: ${JSON.stringify(contents)}`);

rmSync(workspace, { recursive: true, force: true });

if (result.status !== "finished") {
  console.error(`\n!! agent loop did not finish cleanly: ${result.status}`);
  process.exit(1);
}
if (contents?.trim() !== "hi") {
  console.error(`\n!! hello.txt was not written as expected`);
  process.exit(1);
}

console.log("\nprobe ok.");
