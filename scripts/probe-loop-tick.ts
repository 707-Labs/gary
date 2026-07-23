// Run one tick of the poll loop against the real services. Expects zero
// issues assigned to Gary (we verified this in step 2's probe), so the
// expected outcome is: 0 candidates considered, no action taken.
//
// Run with: bun run scripts/probe-loop-tick.ts

import { mkdirSync } from "node:fs";
import { CloudflareClient } from "../src/adapters/cloudflare.ts";
import { GLMClient } from "../src/adapters/glm.ts";
import { makeGitHubClient } from "../src/adapters/github.ts";
import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadConfig } from "../src/config.ts";
import { tick } from "../src/loop.ts";
import { createProvider, createProviderChain } from "../src/providers.ts";
import { closeDb, openDb } from "../src/state/db.ts";

const cfg = loadConfig();
mkdirSync(cfg.gary.stateDir, { recursive: true });
const db = openDb(cfg.gary.dbPath);

const linear = new LinearAdapter({ gary: cfg.gary, linear: cfg.linear });
const github = makeGitHubClient(cfg.github);
const chain = createProviderChain(cfg.providers.map((p) => createProvider(p)));
const glm = new GLMClient(chain);
const cloudflare = cfg.cloudflare ? new CloudflareClient(cfg.cloudflare) : null;

const result = await tick({
  db,
  linear,
  github,
  glm,
  cloudflare,
  repoMap: cfg.gary.repoMap,
  allowlistedMentionUserIds: cfg.gary.allowlistedMentionUserIds,
  reposDir: cfg.gary.reposDir,
  workspacesDir: cfg.gary.workspacesDir,
  agentLoopMaxIterations: cfg.runtime.agentLoopMaxIterations,
  agentLoopTimeoutMs: cfg.runtime.agentLoopTimeoutMs,
  maxCiAttempts: cfg.runtime.maxCiAttempts,
  maxAttemptsPerTicket: cfg.runtime.maxAttemptsPerTicket,
  circuitBreakerWindowHours: cfg.runtime.circuitBreakerWindowHours,
  stalePrAfterMs: cfg.runtime.stalePrAfterMs,
  maxInFlight: cfg.runtime.maxInFlight,
  codingEngine: cfg.runtime.codingEngine,
  piModel: cfg.runtime.piModel,
  review: cfg.review,
  routing: cfg.routing,
});

console.log("\nresult:", result);
closeDb(db);
