import { mkdirSync } from "node:fs";
import { GLMClient } from "./adapters/glm.ts";
import { makeGitHubClient } from "./adapters/github.ts";
import { LinearAdapter } from "./adapters/linear.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { runLoop } from "./loop.ts";
import { closeDb, openDb } from "./state/db.ts";
import { recordEvent } from "./state/queries.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();

  mkdirSync(cfg.gary.home, { recursive: true });
  mkdirSync(cfg.gary.stateDir, { recursive: true });
  mkdirSync(cfg.gary.reposDir, { recursive: true });
  mkdirSync(cfg.gary.workspacesDir, { recursive: true });

  const db = openDb(cfg.gary.dbPath);
  recordEvent(db, { eventType: "boot", payload: { version: "0.0.1" } });

  const linear = new LinearAdapter({ gary: cfg.gary, linear: cfg.linear });
  const github = makeGitHubClient(cfg.github);
  const glm = new GLMClient(cfg.glm);

  log.info("gary booted", {
    name: cfg.gary.name,
    dbPath: cfg.gary.dbPath,
    githubAuth: cfg.github.kind,
    glmModel: cfg.glm.model,
    pollIntervalMs: cfg.runtime.pollIntervalMs,
    allowedRepos: cfg.gary.allowedRepos,
  });

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info("signal received", { signal: sig });
      controller.abort();
    });
  }

  await runLoop({
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
    intervalMs: cfg.runtime.pollIntervalMs,
    signal: controller.signal,
  });

  closeDb(db);
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
