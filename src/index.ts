import { mkdirSync } from "node:fs";
import { CloudflareClient } from "./adapters/cloudflare.ts";
import { GLMClient } from "./adapters/glm.ts";
import { makeGitHubClient } from "./adapters/github.ts";
import { LinearAdapter } from "./adapters/linear.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { runLoop } from "./loop.ts";
import { createProvider, createProviderChain } from "./providers.ts";
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
  const chain = createProviderChain(cfg.providers.map((p) => createProvider(p)));
  const glm = new GLMClient(chain);
  const cloudflare = cfg.cloudflare ? new CloudflareClient(cfg.cloudflare) : null;

  log.info("gary booted", {
    name: cfg.gary.name,
    dbPath: cfg.gary.dbPath,
    githubAuth: cfg.github.kind,
    providers: chain.providers.map((p) => `${p.name}:${p.model}`),
    routing: { main: cfg.routing.main, prFollowup: cfg.routing.prFollowup },
    cloudflare: cloudflare ? cfg.cloudflare?.observabilityWorkers : "disabled",
    pollIntervalMs: cfg.runtime.pollIntervalMs,
    repoMap: Object.fromEntries(cfg.gary.repoMap),
    mentionAllowlistSize: cfg.gary.allowlistedMentionUserIds.length,
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
    review: cfg.review,
    routing: cfg.routing,
    intervalMs: cfg.runtime.pollIntervalMs,
    signal: controller.signal,
  });

  closeDb(db);
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
