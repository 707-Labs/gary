import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CloudflareClient } from './adapters/cloudflare.ts';
import { GLMClient } from './adapters/glm.ts';
import { makeGitHubClient } from './adapters/github.ts';
import { LinearAdapter } from './adapters/linear.ts';
import { loadConfig, type Config } from './config.ts';
import { loadHostStartupConfig } from './host-config.ts';
import { createHermesActivation, loadHermesActivationConfig } from './hermes/activation.ts';
import { createCanaryReadiness } from './hermes/host-readiness.ts';
import type { GaryRuntimeLauncher } from './hermes/gary-loop-adapter.ts';
import { log } from './logger.ts';
import { runLoop, type RunLoopArgs } from './loop.ts';
import { createProvider, createProviderChain } from './providers.ts';
import { openDb } from './state/db.ts';
import { recordEvent } from './state/queries.ts';
import { openSpendLedger } from './spend.ts';
import { loadSlackCredentials, type SlackCredentials } from './slack/credentials.ts';
import { createSlackTransport, type SlackTransport } from './slack/transport.ts';
import { createSlackService, type SlackService } from './slack/service.ts';
import { runReadonlyGaryHost, type ReadonlyStartupDependencies } from './readonly-startup.ts';

/** Test dependencies are trusted code, never environment or task JSON. */
export interface StartupDependencies extends ReadonlyStartupDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  config?: () => Config;
  linear?: (config: Config) => LinearAdapter;
  github?: typeof makeGitHubClient;
  cloudflare?: (config: NonNullable<Config['cloudflare']>) => CloudflareClient;
  db?: typeof openDb;
  ledger?: typeof openSpendLedger;
  fetch?: typeof fetch;
  launch?: GaryRuntimeLauncher;
  runLoop?: (args: RunLoopArgs) => Promise<void>;
  signal?: AbortSignal;
  slackTransport?: (credentials: SlackCredentials) => SlackTransport;
}

/** Both production and fixture entrypoints use this composition; imports are inert. */
export async function runGaryHost(deps: StartupDependencies = {}): Promise<void> {
  const host = loadHostStartupConfig(deps.env ?? process.env);
  if (host.mode === 'hermes-readonly-canary') return runReadonlyGaryHost(host, deps);
  const activationConfig = host.activationPath ? loadHermesActivationConfig(host.activationPath) : undefined;
  const cfg = (deps.config ?? loadConfig)();
  const providerConfigs = cfg.providers.filter(provider => provider.name === 'deepseek');
  if (activationConfig && (providerConfigs.length !== 1 || providerConfigs[0]?.model !== activationConfig.model
      || providerConfigs[0]?.baseUrl !== 'https://api.deepseek.com/anthropic'
      || ![...cfg.gary.repoMap.values()].includes(activationConfig.repo))) throw new Error('hermes_host_route_or_repository_mismatch');
  const slackCredentials = host.slack ? await loadSlackCredentials(host.slack.credentialsPath) : undefined;
  for (const directory of [cfg.gary.home, cfg.gary.stateDir, cfg.gary.reposDir, cfg.gary.workspacesDir]) mkdirSync(directory, { recursive: true });
  const db = (deps.db ?? openDb)(cfg.gary.dbPath);
  let spend: ReturnType<typeof openSpendLedger> | undefined;
  let slack: SlackService | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    // Stop ingress/sends immediately; the current coding tick retains its normal drain semantics.
    // The finally block awaits the same stop promise before closing canonical handles.
    void slack?.stop().catch(() => undefined);
  };
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => { log.info('signal received', { signal }); abort(); };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  try {
    spend = (deps.ledger ?? openSpendLedger)(resolve(cfg.gary.stateDir, 'spend.db'));
    const linear = deps.linear ? deps.linear(cfg) : new LinearAdapter({ gary: cfg.gary, linear: cfg.linear });
    const github = (deps.github ?? makeGitHubClient)(cfg.github);
    const rawFetch = deps.fetch ?? globalThis.fetch;
    const chain = createProviderChain(providerConfigs.map(provider => createProvider(provider, { fetch: spend!.guardedFetch(provider.name, rawFetch) })));
    const glm = new GLMClient(chain);
    const cloudflare = cfg.cloudflare ? (deps.cloudflare ? deps.cloudflare(cfg.cloudflare) : new CloudflareClient(cfg.cloudflare)) : null;
    const activation = activationConfig ? createHermesActivation(activationConfig, { db, ledger: spend,
      route: { provider: activationConfig.provider, model: activationConfig.model, providerApiKey: providerConfigs[0]!.apiKey,
        fetch: request => rawFetch(request) }, ...(deps.launch ? { launch: deps.launch } : {}) }) : undefined;
    const readiness = activation && activationConfig ? createCanaryReadiness({ db, ledger: spend, activation,
      issueId: activationConfig.issueId, repo: activationConfig.repo }) : undefined;
    if (controller.signal.aborted) return;
    if (host.slack && slackCredentials && readiness) {
      const transport = deps.slackTransport ? deps.slackTransport(slackCredentials) : createSlackTransport({ credentials: slackCredentials });
      slack = createSlackService({ db, transport, checkHostHealth: readiness.check, approvedChannelIds: host.slack.approvedChannelIds });
      const health = await slack.start();
      if (controller.signal.aborted) return;
      if (!health.running || !health.identityVerified || !health.socketHealthy) throw new Error('slack_startup_health_failed');
    }
    recordEvent(db, { eventType: 'boot', payload: { version: '0.0.1', runtime: host.mode } });
    log.info('gary booted', { name: cfg.gary.name, dbPath: cfg.gary.dbPath, githubAuth: cfg.github.kind,
      providers: chain.providers.map(provider => `${provider.name}:${provider.model}`), runtime: host.mode,
      canaryIssueId: activationConfig?.issueId ?? null, slack: slack ? 'connected' : 'disabled', pollIntervalMs: cfg.runtime.pollIntervalMs });
    await (deps.runLoop ?? runLoop)({ db, spend, linear, github, glm, cloudflare,
      repoMap: cfg.gary.repoMap, allowlistedMentionUserIds: cfg.gary.allowlistedMentionUserIds,
      reposDir: cfg.gary.reposDir, workspacesDir: cfg.gary.workspacesDir,
      agentLoopMaxIterations: cfg.runtime.agentLoopMaxIterations, agentLoopTimeoutMs: cfg.runtime.agentLoopTimeoutMs,
      maxCiAttempts: cfg.runtime.maxCiAttempts, maxAttemptsPerTicket: cfg.runtime.maxAttemptsPerTicket,
      circuitBreakerWindowHours: cfg.runtime.circuitBreakerWindowHours, stalePrAfterMs: cfg.runtime.stalePrAfterMs,
      review: cfg.review, intervalMs: cfg.runtime.pollIntervalMs, signal: controller.signal,
      ...(activation ? { allowedIssueIds: activation.allowedIssueIds, allowedActionTypes: activation.allowedActionTypes,
        createAdmittedCodeLoop: activation.createAdmittedCodeLoop, onCodePublication: readiness!.recordPublication } : {}),
      ...(slack ? { onTickComplete: async () => {
        if (controller.signal.aborted) return;
        const health = await slack!.refreshHealth();
        log.info('slack health', { connected: health.running && health.identityVerified && health.socketHealthy,
          hostReady: health.hostReady, readyDelivery: health.readyDelivery });
      } } : {}),
    });
  } finally {
    abort();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    deps.signal?.removeEventListener('abort', abort);
    try { await slack?.stop(); } finally {
      try { spend?.close(); } finally { db.close(); }
    }
  }
}
