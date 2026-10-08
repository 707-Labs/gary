import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createExecutorJobJournal, reconcileDockerExecutorJobs, type ExecutorJobJournal } from './executors/index.ts';
import { CloudflareClient } from './adapters/cloudflare.ts';
import { GLMClient } from './adapters/glm.ts';
import { makeGitHubClient } from './adapters/github.ts';
import { LinearAdapter } from './adapters/linear.ts';
import { loadConfig, type Config } from './config.ts';
import { loadHostStartupConfig } from './host-config.ts';
import { createHermesActivation, loadHermesActivationConfig } from './hermes/activation.ts';
import { HERMES_CODING_RUNTIME_POLICY } from './hermes/coding-runtime-policy.ts';
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
import { runReadonlyGaryHost, verifyReadonlyRelease, type ReadonlyStartupDependencies } from './readonly-startup.ts';
import { createSlackConversation, loadSlackConversationConfig, fingerprintSlackConversationConfig, type SlackConversation } from './slack/conversation.ts';
import { createSlackSharedConversation, loadSlackSharedConversationConfig, fingerprintSlackSharedConversationConfig, type SlackSharedConversation } from './slack/shared-conversation.ts';
import { createHermesDMResponder, createHermesSharedResponder } from './hermes/dm-conversation.ts';

/** Test dependencies are trusted code, never environment or task JSON. */
export interface StartupDependencies extends ReadonlyStartupDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  /** Exact release verification seam for offline fixtures only. */
  verifyConversationRelease?: (expected:string)=>void;
  config?: () => Config;
  linear?: (config: Config) => LinearAdapter;
  github?: typeof makeGitHubClient;
  cloudflare?: (config: NonNullable<Config['cloudflare']>) => CloudflareClient;
  db?: typeof openDb;
  ledger?: typeof openSpendLedger;
  fetch?: typeof fetch;
  launch?: GaryRuntimeLauncher;
  /** Trusted offline lifecycle seam; production always uses the durable Docker journal. */
  executorJobs?: { create: typeof createExecutorJobJournal; reconcile: typeof reconcileDockerExecutorJobs };
  runLoop?: (args: RunLoopArgs) => Promise<void>;
  signal?: AbortSignal;
  slackTransport?: (credentials: SlackCredentials) => SlackTransport;
}

/** Both production and fixture entrypoints use this composition; imports are inert. */
export async function runGaryHost(deps: StartupDependencies = {}): Promise<void> {
  const host = loadHostStartupConfig(deps.env ?? process.env);
  if (host.mode === 'hermes-readonly-canary') return runReadonlyGaryHost(host, deps);
  if(host.conversationRuntimeRelease)(deps.verifyConversationRelease??verifyReadonlyRelease)(host.conversationRuntimeRelease);
  const conversationConfig=host.slackConversationConfigPath?loadSlackConversationConfig(host.slackConversationConfigPath):undefined;
  const sharedConfig=host.slackSharedConversationConfigPath?loadSlackSharedConversationConfig(host.slackSharedConversationConfigPath):undefined;
  if(conversationConfig&&sharedConfig&&conversationConfig.contextDirectory===sharedConfig.contextDirectory)throw new Error('conversation_contexts_must_be_separate');
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
  let conversation:SlackConversation|undefined;
  let sharedConversation:SlackSharedConversation|undefined;
  let executorJobJournal: ExecutorJobJournal | undefined;
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
    if (controller.signal.aborted) return;
    spend = (deps.ledger ?? openSpendLedger)(resolve(cfg.gary.stateDir, 'spend.db'));
    if (activationConfig) {
      executorJobJournal = (deps.executorJobs?.create ?? createExecutorJobJournal)({
        directory:join(activationConfig.traceDirectory,'executor-jobs'), dockerBinary:activationConfig.dockerExecutable,
        dockerHost:activationConfig.dockerHost });
      // No adapters, admission, polling or Slack connection until old exact jobs are absent.
      await (deps.executorJobs?.reconcile ?? reconcileDockerExecutorJobs)(executorJobJournal);
      if (controller.signal.aborted) return;
    }
    const linear = deps.linear ? deps.linear(cfg) : new LinearAdapter({ gary: cfg.gary, linear: cfg.linear });
    const github = (deps.github ?? makeGitHubClient)(cfg.github);
    const rawFetch = deps.fetch ?? globalThis.fetch;
    const chain = createProviderChain(providerConfigs.map(provider => createProvider(provider, { fetch: spend!.guardedFetch(provider.name, rawFetch) })));
    const glm = new GLMClient(chain);
    const cloudflare = cfg.cloudflare ? (deps.cloudflare ? deps.cloudflare(cfg.cloudflare) : new CloudflareClient(cfg.cloudflare)) : null;
    const activation = activationConfig ? createHermesActivation(activationConfig, { db, ledger: spend, executorJobJournal:executorJobJournal!,
      route: { provider: activationConfig.provider, model: activationConfig.model, providerApiKey: providerConfigs[0]!.apiKey,
        fetch: request => rawFetch(request) }, ...(deps.launch ? { launch: deps.launch } : {}) }) : undefined;
    const readiness = activation && activationConfig ? createCanaryReadiness({ db, ledger: spend, activation,
      issueId: activationConfig.issueId, repo: activationConfig.repo }) : undefined;
    if (controller.signal.aborted) return;
    if (host.slack && slackCredentials && readiness) {
      const transport = deps.slackTransport ? deps.slackTransport(slackCredentials) : createSlackTransport({ credentials: slackCredentials });
      const responderDeps={ledger:spend,providerApiKey:providerConfigs[0]!.apiKey,fetch:(request:Request)=>rawFetch(request),...(deps.launch?{launch:deps.launch}:{})};
      if(conversationConfig)conversation=createSlackConversation({config:conversationConfig,ledger:spend,reply:createHermesDMResponder(responderDeps)});
      if(sharedConfig){
        try {
          if(!transport.memberInfo||!transport.channelInfo)throw new Error('shared_metadata_unavailable');
          sharedConversation=createSlackSharedConversation({config:sharedConfig,ledger:spend,reply:createHermesSharedResponder(responderDeps),
            metadata:{memberInfo:(id,signal)=>transport.memberInfo!(id,signal),channelInfo:(id,signal)=>transport.channelInfo!(id,signal)}});
        }catch{log.warn('shared conversation unavailable',{reason:'shared_runtime_initialization_rejected'});}
      }
      slack = createSlackService({ db, transport, checkHostHealth: readiness.check, approvedChannelIds: host.slack.approvedChannelIds,
        ...(conversation?{conversation,tannerDirectMessages:true as const}:{}),...(sharedConversation?{sharedConversation}:{}),
        ...(host.conversationRuntimeRelease?{checkConversationHealth:()=>!controller.signal.aborted}: {}) });
      const health = await slack.start();
      if (controller.signal.aborted) return;
      if (!health.running || !health.identityVerified || !health.socketHealthy) throw new Error('slack_startup_health_failed');
      if(conversationConfig&&conversation){if(!conversation.ready())throw new Error('dm_conversation_not_ready');
        log.info('conversation runtime ready',{kind:'private_dm',runId:conversationConfig.runId,allocationId:conversationConfig.allocationId,
          configFingerprint:fingerprintSlackConversationConfig(conversationConfig),release:host.conversationRuntimeRelease,tools:'none'});}
      if(sharedConfig&&sharedConversation)log.info('conversation runtime ready',{kind:'shared_channel',ready:sharedConversation.ready(),runId:sharedConfig.runId,
        allocationId:sharedConfig.allocationId,configFingerprint:fingerprintSlackSharedConversationConfig(sharedConfig),release:host.conversationRuntimeRelease,tools:'none',trigger:'explicit_mention'});
    }
    recordEvent(db, { eventType: 'boot', payload: { version: '0.0.1', runtime: host.mode } });
    log.info('gary booted', { name: cfg.gary.name, dbPath: cfg.gary.dbPath, githubAuth: cfg.github.kind,
      providers: chain.providers.map(provider => `${provider.name}:${provider.model}`), runtime: host.mode,
      canaryIssueId: activationConfig?.issueId ?? null, slack: slack ? 'connected' : 'disabled', pollIntervalMs: cfg.runtime.pollIntervalMs });
    await (deps.runLoop ?? runLoop)({ db, spend, linear, github, glm, cloudflare,
      repoMap: cfg.gary.repoMap, allowlistedMentionUserIds: cfg.gary.allowlistedMentionUserIds,
      reposDir: cfg.gary.reposDir, workspacesDir: cfg.gary.workspacesDir,
      agentLoopMaxIterations: cfg.runtime.agentLoopMaxIterations, agentLoopTimeoutMs: activation ? HERMES_CODING_RUNTIME_POLICY.actionTimeoutMs : cfg.runtime.agentLoopTimeoutMs,
      maxCiAttempts: cfg.runtime.maxCiAttempts, maxAttemptsPerTicket: cfg.runtime.maxAttemptsPerTicket,
      circuitBreakerWindowHours: cfg.runtime.circuitBreakerWindowHours, stalePrAfterMs: cfg.runtime.stalePrAfterMs,
      review: activation ? {...HERMES_CODING_RUNTIME_POLICY.review,providerOrder:[...HERMES_CODING_RUNTIME_POLICY.review.providerOrder]} : cfg.review, intervalMs: cfg.runtime.pollIntervalMs, signal: controller.signal,
      ...(activation ? { allowedIssueIds: activation.allowedIssueIds, allowedActionTypes: activation.allowedActionTypes,
        codingTrial: activation.codingTrial, codingBase: activation.codeBase, codingExecutorProfile: HERMES_CODING_RUNTIME_POLICY.executor, createAdmittedCodeLoop: activation.createAdmittedCodeLoop, createCodeVerification:activation.createCodeVerification, onCodePublication: readiness!.recordPublication } : {}),
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
      try {
        try{if(conversation)log.info('conversation runtime stopped',{kind:'private_dm',drained:conversation.close().drained});}
        finally{if(sharedConversation)log.info('conversation runtime stopped',{kind:'shared_channel',drained:sharedConversation.close().drained});}
      } finally {try { executorJobJournal?.close(); } finally { try { spend?.close(); } finally { db.close(); } }}
    }
  }
}
