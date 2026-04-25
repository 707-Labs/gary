// Run one tick of the poll loop against the real services. Expects zero
// issues assigned to Gary (we verified this in step 2's probe), so the
// expected outcome is: 0 candidates considered, no action taken.
//
// Run with: bun run scripts/probe-loop-tick.ts

import { mkdirSync } from "node:fs";
import { GLMClient } from "../src/adapters/glm.ts";
import { makeGitHubClient } from "../src/adapters/github.ts";
import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadConfig } from "../src/config.ts";
import { tick } from "../src/loop.ts";
import { closeDb, openDb } from "../src/state/db.ts";

const cfg = loadConfig();
mkdirSync(cfg.gary.stateDir, { recursive: true });
const db = openDb(cfg.gary.dbPath);

const linear = new LinearAdapter({ gary: cfg.gary, linear: cfg.linear });
const github = makeGitHubClient(cfg.github);
const glm = new GLMClient(cfg.glm);

const result = await tick({
  db,
  linear,
  github,
  glm,
  allowedRepos: cfg.gary.allowedRepos,
  reposDir: cfg.gary.reposDir,
  workspacesDir: cfg.gary.workspacesDir,
  agentLoopMaxIterations: cfg.runtime.agentLoopMaxIterations,
  agentLoopTimeoutMs: cfg.runtime.agentLoopTimeoutMs,
  maxCiAttempts: cfg.runtime.maxCiAttempts,
  maxAttemptsPerTicket: cfg.runtime.maxAttemptsPerTicket,
  circuitBreakerWindowHours: cfg.runtime.circuitBreakerWindowHours,
});

console.log("\nresult:", result);
closeDb(db);
