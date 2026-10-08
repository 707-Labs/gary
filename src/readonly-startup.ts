/** One read-only activation in the existing Gary host. No ticket polling or publication clients. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGaryConfig, loadProviderConfigs } from './config.ts';
import type { ProviderConfig } from './providers.ts';
import type { HostStartupConfig } from './host-config.ts';
import type { StartupDependencies } from './startup.ts';
import { createReadonlyCanary, loadReadonlyCanaryConfig } from './hermes/readonly-canary.ts';
import { loadSlackCredentials } from './slack/credentials.ts';
import { createSlackTransport } from './slack/transport.ts';
import { createSlackService, type SlackService } from './slack/service.ts';
import { openDb } from './state/db.ts';
import { openSpendLedger } from './spend.ts';
import { log } from './logger.ts';

export interface ReadonlyStartupDependencies {
  /** All injection points are trusted offline-test code, never configuration data. */
  readonlySetup?: () => { stateDir: string; provider: ProviderConfig };
  verifyReadonlyRelease?: (expected: string, slackRelease?:string) => void;
  readonlyCanary?: typeof createReadonlyCanary;
  waitReadonlyIdle?: (signal: AbortSignal, refresh: () => Promise<void>) => Promise<void>;
}
export function verifyReadonlyRelease(expected: string, slackRelease?:string, cwd=resolve(dirname(fileURLToPath(import.meta.url)), '..')): void {
  const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    { cwd, env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if(!/^[a-f0-9]{40}$/.test(expected)||(slackRelease!==undefined&&!/^[a-f0-9]{40}$/.test(slackRelease)))throw new Error('readonly_release_mismatch');
  if (git(['rev-parse', 'HEAD']) !== (slackRelease??expected) || git(['status', '--porcelain=v1', '--untracked-files=no'])) {
    throw new Error('readonly_release_mismatch');
  }
  if(slackRelease!==undefined) {
    git(['merge-base','--is-ancestor',expected,slackRelease]);
    // Only this explicitly pinned, independently reviewed Slack patch may reuse
    // the existing model/tool proof. No runtime, provider, executor, dependency,
    // entrypoint, native worker, or receipt source is allowed to differ.
    const allowed=new Set(['src/slack/service.ts','src/host-config.ts','src/readonly-startup.ts',
      'test/slack/service.test.ts','test/host-config.test.ts','test/readonly-startup.test.ts']);
    const changed=git(['diff','--name-only',expected,slackRelease]).split('\n').filter(Boolean);
    if(!changed.length||changed.some(file=>!allowed.has(file)))throw new Error('readonly_slack_release_scope_mismatch');
  }
}
async function idle(signal: AbortSignal, refresh: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, 30_000);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    if (!signal.aborted) await refresh();
  }
}
export async function runReadonlyGaryHost(host: HostStartupConfig, deps: StartupDependencies): Promise<void> {
  if (host.mode !== 'hermes-readonly-canary' || !host.activationPath || !host.slack || host.slack.approvedChannelIds.length) {
    throw new Error('readonly_startup_configuration_rejected');
  }
  const config = loadReadonlyCanaryConfig(host.activationPath);
  (deps.verifyReadonlyRelease ?? verifyReadonlyRelease)(config.releaseCommit,host.readonlySlackReleaseCommit);
  const setup = deps.readonlySetup ? deps.readonlySetup() : (() => {
    const providers = loadProviderConfigs().filter(provider => provider.name === 'deepseek');
    if (providers.length !== 1) throw new Error('readonly_provider_unavailable');
    return { stateDir: loadGaryConfig().stateDir, provider: providers[0]! };
  })();
  const provider = setup.provider;
  if (provider.name !== 'deepseek' || provider.model !== 'deepseek-v4-pro'
      || provider.baseUrl !== 'https://api.deepseek.com/anthropic' || !provider.apiKey) throw new Error('readonly_route_mismatch');
  const credentials = await loadSlackCredentials(host.slack.credentialsPath);
  const db = (deps.db ?? openDb)(resolve(setup.stateDir, 'gary.db'));
  let ledger: ReturnType<typeof openSpendLedger> | undefined;
  let slack: SlackService | undefined;
  const controller = new AbortController();
  const abort = () => { controller.abort(); void slack?.stop().catch(() => undefined); };
  const onInt = () => { log.info('signal received', { signal: 'SIGINT' }); abort(); };
  const onTerm = () => { log.info('signal received', { signal: 'SIGTERM' }); abort(); };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  try {
    if (controller.signal.aborted) return;
    db.exec('PRAGMA synchronous=FULL');
    if ((db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous !== 2) throw new Error('readonly_database_not_durable');
    ledger = (deps.ledger ?? openSpendLedger)(resolve(setup.stateDir, 'spend.db'));
    const rawFetch = deps.fetch ?? globalThis.fetch;
    const canary = (deps.readonlyCanary ?? createReadonlyCanary)(config, { db, ledger,
      route: { provider: 'deepseek', model: 'deepseek-v4-pro', providerApiKey: provider.apiKey, fetch: request => rawFetch(request) },
      signal: controller.signal, ...(deps.launch ? { launch: deps.launch } : {}) });
    const transport = deps.slackTransport ? deps.slackTransport(credentials) : createSlackTransport({ credentials });
    if(host.readonlySlackReleaseCommit&&!canary.check().ready)throw new Error('readonly_slack_release_requires_existing_receipt');
    slack = createSlackService({ db, transport, checkHostHealth: canary.check, approvedChannelIds: [],
      ...(host.slack.tannerDirectMessages?{tannerDirectMessages:true as const}:{}) });
    const initial = await slack.start();
    if (controller.signal.aborted) return;
    if (!initial.running || !initial.identityVerified || !initial.socketHealthy) throw new Error('readonly_slack_identity_unavailable');
    if (!canary.check().ready) {
      if(host.readonlySlackReleaseCommit)throw new Error('readonly_slack_release_requires_existing_receipt');
      await canary.run();
    }
    if (controller.signal.aborted) return;
    const ready = await slack.refreshHealth();
    if (!ready.hostReady || ready.readinessKind !== 'readonly_runtime' || !ready.identityVerified || !ready.socketHealthy
        || ready.readyDelivery !== 'sent') throw new Error('readonly_ready_delivery_unconfirmed');
    log.info('readonly canary ready', { runId: config.runId, receiptId: ready.readinessReceiptId,
      readyDelivery: ready.readyDelivery, runtime: host.mode, codingDispatch: 'disabled' });
    await (deps.waitReadonlyIdle ?? idle)(controller.signal, async () => {
      const health = await slack!.refreshHealth();
      log.info('readonly slack health', { connected: health.running && health.identityVerified && health.socketHealthy,
        hostReady: health.hostReady, readyDelivery: health.readyDelivery });
    });
  } finally {
    abort();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    deps.signal?.removeEventListener('abort', abort);
    try { await slack?.stop(); } finally {
      try {
        if (ledger?.status(config.allocationId)?.state === 'active') ledger.markTerminal(config.allocationId, 'readonly_host_stopped');
      } finally { try { ledger?.close(); } finally { db.close(); } }
    }
    log.info('readonly host stopping');
  }
}
