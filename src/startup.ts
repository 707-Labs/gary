import { logSlackIngressDiagnostic } from './slack/ingress-diagnostics.ts';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { Database } from 'bun:sqlite';
import { createExecutorJobJournal, reconcileDockerExecutorJobs, type ExecutorJobJournal } from './executors/index.ts';
import { CloudflareClient } from './adapters/cloudflare.ts';
import { GLMClient } from './adapters/glm.ts';
import { makeGitHubClient } from './adapters/github.ts';
import { LinearAdapter } from './adapters/linear.ts';
import { loadConfig, type Config } from './config.ts';
import { loadHostStartupConfig } from './host-config.ts';
import { createHermesActivation, loadHermesActivationConfig } from './hermes/activation.ts';
import { HERMES_CODING_RUNTIME_POLICY, fingerprintHermesCodingActivation } from './hermes/coding-runtime-policy.ts';
import { createCanaryReadiness } from './hermes/host-readiness.ts';
import type { GaryRuntimeLauncher } from './hermes/gary-loop-adapter.ts';
import { log } from './logger.ts';
import { createLoopWake, runLoop, type RunLoopArgs } from './loop.ts';
import { createProvider, createProviderChain } from './providers.ts';
import { openDb } from './state/db.ts';
import { recordEvent } from './state/queries.ts';
import { openSpendLedger } from './spend.ts';
import { loadSlackCredentials, type SlackCredentials } from './slack/credentials.ts';
import { createSlackTransport, type SlackTransport } from './slack/transport.ts';
import { createSlackService, type SlackService, type EngineeringReceipt } from './slack/service.ts';
import { runReadonlyGaryHost, verifyReadonlyRelease, type ReadonlyStartupDependencies } from './readonly-startup.ts';
import { createSlackConversation, loadSlackConversationConfig, fingerprintSlackConversationConfig, type SlackConversation } from './slack/conversation.ts';
import { createSlackSharedConversation, loadSlackSharedConversationConfig, fingerprintSlackSharedConversationConfig, type SlackSharedConversation } from './slack/shared-conversation.ts';
import { loadSlackAlertConfig,openSlackAlertDatabase } from './slack/alert-config.ts';
import { createSlackAlertIntake,type SlackAlertIntake } from './slack/alert-intake.ts';
import { createHermesDMResponder, createHermesSharedResponder } from './hermes/dm-conversation.ts';
import { ProjectAssistant } from './hermes/project-assistant.ts';
import { loadProjectRuntimeConfig } from './hermes/project-config.ts';
import { createCurrentWorkReader } from './hermes/work-context.ts';
import { createLinearTicketReader, createLocalRepositoryReader } from './hermes/project-integrations.ts';
import { createConversationController, type ConversationControllerRuntime } from './hermes/conversation-controller.ts';
import { createHermesProjectResponder } from './hermes/project-conversation.ts';
import { DMReplyError,type DMTurn } from './hermes/dm-conversation.ts';
import { loadEngineeringRuntimeConfig } from './hermes/engineering-config.ts';
import { openEngineeringRoutineServices } from './hermes/engineering-routine-composition.ts';
import { createEngineeringRuntime } from './hermes/engineering-runtime.ts';
import { createEngineeringGitHubRepositoryServices, resolveEngineeringDefaultBase } from './hermes/engineering-repository.ts';
import { loadStandingEngineeringConfig } from './hermes/standing-engineering-config.ts';
import { createStandingEngineeringBudget } from './hermes/engineering-standing-budget.ts';
import { createStandingEngineeringFundingGuard } from './hermes/engineering-standing-funding.ts';
import { assertEngineeringBudgetAdmission, type EngineeringBudgetBinding } from './hermes/engineering-budget.ts';
import { assertEngineeringContinuationBudget, type EngineeringContinuationBinding } from './hermes/engineering-continuation-budget.ts';

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
  /** Offline composition seams; never selected by environment or model input. */
  engineering?: { createRoutine?: typeof openEngineeringRoutineServices; createRuntime?: typeof createEngineeringRuntime; assertBudget?: typeof assertEngineeringBudgetAdmission;
    assertContinuation?: typeof assertEngineeringContinuationBudget };
}

function openEngineeringJournal(path: string): Database {
  const root = dirname(path), parent = lstatSync(root);
  if (realpathSync(root) !== root || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error('engineering_private_storage_rejected');
  try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || realpathSync(path) !== path) throw new Error('engineering_private_storage_rejected');
  const db = new Database(path, { strict: true, create: false });
  try {
    const after = lstatSync(path); if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('engineering_private_storage_replaced');
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    return db;
  } catch (error) { db.close(); throw error; }
}
function overlappingRoots(a: string, b: string): boolean {
  const inside = (base: string, path: string) => { const rel = relative(base, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); };
  return inside(a, b) || inside(b, a);
}

/** Both production and fixture entrypoints use this composition; imports are inert. */
export async function runGaryHost(deps: StartupDependencies = {}): Promise<void> {
  const host = loadHostStartupConfig(deps.env ?? process.env);
  if (host.mode === 'hermes-readonly-canary') return runReadonlyGaryHost(host, deps);
  if(host.conversationRuntimeRelease)(deps.verifyConversationRelease??verifyReadonlyRelease)(host.conversationRuntimeRelease);
  const conversationConfig=host.slackConversationConfigPath?loadSlackConversationConfig(host.slackConversationConfigPath):undefined;
  const sharedConfig=host.slackSharedConversationConfigPath?loadSlackSharedConversationConfig(host.slackSharedConversationConfigPath):undefined;
  const projectConfig=host.projectAssistantConfigPath?loadProjectRuntimeConfig(host.projectAssistantConfigPath,host.projectAssistantConfigSha256!):undefined;
  const alertConfig=host.slackAlertConfigPath?loadSlackAlertConfig(host.slackAlertConfigPath,host.slackAlertConfigSha256!):undefined;
  const engineeringConfig=host.engineeringConfigPath?loadEngineeringRuntimeConfig(host.engineeringConfigPath,host.engineeringConfigSha256!,
    host.engineeringAuthorityReceiptPath!,host.engineeringAuthorityReceiptSha256!):undefined;
  const standingConfig=host.standingEngineeringConfigPath?loadStandingEngineeringConfig(host.standingEngineeringConfigPath,
    host.standingEngineeringConfigSha256!,host.standingEngineeringAuthorityPath!,host.standingEngineeringAuthoritySha256!):undefined;
  if(standingConfig&&standingConfig.sourceRevision!==host.conversationRuntimeRelease)throw new Error('standing_engineering_source_release_mismatch');
  if(engineeringConfig&&engineeringConfig.sourceRevision!==host.conversationRuntimeRelease)throw new Error('engineering_source_release_mismatch');
  if(engineeringConfig&&[conversationConfig?.contextDirectory,sharedConfig?.contextDirectory,alertConfig?.directory,
    host.projectAssistantConfigPath?dirname(host.projectAssistantConfigPath):undefined].some(path=>path&&(overlappingRoots(engineeringConfig.root,path)
      ||overlappingRoots(engineeringConfig.workspacesRoot,path))))throw new Error('engineering_context_must_be_separate');
  if(standingConfig&&[conversationConfig?.contextDirectory,sharedConfig?.contextDirectory,alertConfig?.directory,
    host.projectAssistantConfigPath?dirname(host.projectAssistantConfigPath):undefined].some(path=>path&&(overlappingRoots(standingConfig.root,path)
      ||overlappingRoots(standingConfig.workspacesRoot,path)
      ||standingConfig.routine&&overlappingRoots(standingConfig.routine.scopedRoot,path))))throw new Error('standing_engineering_context_must_be_separate');
  if(alertConfig&&[conversationConfig?.contextDirectory,sharedConfig?.contextDirectory,host.projectAssistantConfigPath?dirname(host.projectAssistantConfigPath):undefined].includes(alertConfig.directory))throw new Error('alert_context_must_be_separate');
  if(conversationConfig&&sharedConfig&&conversationConfig.contextDirectory===sharedConfig.contextDirectory)throw new Error('conversation_contexts_must_be_separate');
  const activationConfig = host.activationPath ? loadHermesActivationConfig(host.activationPath) : undefined;
  const cfg = (deps.config ?? loadConfig)();
  const providerConfigs = cfg.providers.filter(provider => provider.name === 'deepseek');
  if((engineeringConfig||standingConfig)&&(cfg.github.kind!=='app'||providerConfigs.length!==1||providerConfigs[0]?.model!=='deepseek-v4-pro'
    ||providerConfigs[0]?.baseUrl!=='https://api.deepseek.com/anthropic'||!providerConfigs[0]?.apiKey))throw new Error('engineering_host_route_rejected');
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
  let alertIntake:SlackAlertIntake|undefined;
  let alertDb:ReturnType<typeof openSlackAlertDatabase>|undefined;
  let projects:ProjectAssistant|undefined;
  let executorJobJournal: ExecutorJobJournal | undefined;
  let engineering:ReturnType<typeof createEngineeringRuntime>|undefined;
  let engineeringDb:Database|undefined,engineeringSpendDb:Database|undefined;
  let routineServices:ReturnType<typeof openEngineeringRoutineServices>|undefined;
  let standingBudget:ReturnType<typeof createStandingEngineeringBudget>|undefined;
  let legacyDispatches=0,conversationDispatches=0;
  const pendingEngineeringStarts=new Map<string,EngineeringReceipt>();
  const controller = new AbortController();
  const flushEngineeringStarts=()=>{
    if(controller.signal.aborted||legacyDispatches||conversationDispatches||!engineering)return;
    for(const [id,receipt] of pendingEngineeringStarts){
      pendingEngineeringStarts.delete(id);engineering.ingress.start?.(receipt);
    }
  };
  const loopWake = createLoopWake();
  let loopState: ConversationControllerRuntime['loopState'] = 'disabled';
  const abort = () => {
    loopState = 'stopped';
    loopWake.stop();
    controller.abort();
    pendingEngineeringStarts.clear();
    // Stop ingress/sends immediately; the current coding tick retains its normal drain semantics.
    // The finally block awaits the same stop promise before closing canonical handles.
    void slack?.stop().catch(() => undefined);
    void engineering?.stop().catch(() => undefined);
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
      const transport = deps.slackTransport ? deps.slackTransport(slackCredentials) : createSlackTransport({ credentials: slackCredentials, onIngressDiagnostic:logSlackIngressDiagnostic });
      const responderDeps={ledger:spend,providerApiKey:providerConfigs[0]!.apiKey,fetch:(request:Request)=>rawFetch(request),...(deps.launch?{launch:deps.launch}:{})};
      let projectReply:((turn:DMTurn)=>Promise<string>)|undefined;
      if(projectConfig){
        for(const project of projectConfig.projects)if(project.teamKey!=='GARY'&&cfg.gary.repoMap.get(project.teamKey)!==project.repo)throw new Error('project_repository_map_mismatch');
        // The hash-pinned host config binds these local roots to repositories. No
        // model argument can select a checkout, client, team or audience.
        const repositories=projectConfig.projects.flatMap(project=>project.root
          ? [{projectId:project.id,repo:project.repo,teamKey:project.teamKey,root:project.root}] : []);
        projects=new ProjectAssistant({...projectConfig,currentWork:createCurrentWorkReader(db,projectConfig.projects),integrations:{
          ticketDetail:createLinearTicketReader(linear),repository:createLocalRepositoryReader(repositories),repositoryProjectIds:repositories.map(p=>p.projectId),
          controller:createConversationController({db,ledger:spend,teamId:projectConfig.teamId,ownerUserId:projectConfig.ownerUserId,
            projects:projectConfig.projects,...(activation&&activationConfig?{activation:{issueId:activationConfig.issueId,repo:activationConfig.repo,
              policyFingerprint:fingerprintHermesCodingActivation(activationConfig),allowedActionTypes:activation.allowedActionTypes}}:{}),
            runtime:()=>({loopState,dispatchReady:!controller.signal.aborted&&!!activation&&loopState!=='disabled'&&loopState!=='stopped'}),
            wake:()=>!controller.signal.aborted&&loopWake.request()})}});
        const respond=createHermesProjectResponder({...responderDeps,projects,
          onFailureDiagnostic:value=>log.error('project turn diagnostic',value)});
        projectReply=turn=>{if(!turn.authority)throw new DMReplyError('project_authority_required');return respond({...turn,authority:turn.authority});};
      }
      if(conversationConfig){
        const reply=projectReply??createHermesDMResponder(responderDeps);
        const base=createSlackConversation({config:conversationConfig,ledger:spend,reply:turn=>standingBudget
          ? standingBudget.withCodingConversation(conversationConfig!.allocationId,()=>reply(turn)) : reply(turn)});
        conversation={...base,async respond(...args){
          if(engineering?.busy())return;
          conversationDispatches++;try{await base.respond(...args);}finally{conversationDispatches--;flushEngineeringStarts();}
        }};
      }
      if(sharedConfig){
        try {
          if(!transport.memberInfo||!transport.channelInfo)throw new Error('shared_metadata_unavailable');
          const base=createSlackSharedConversation({config:sharedConfig,ledger:spend,onIngressDiagnostic:logSlackIngressDiagnostic,reply:projectReply??createHermesSharedResponder(responderDeps),
            metadata:{memberInfo:(id,signal)=>transport.memberInfo!(id,signal),channelInfo:(id,signal)=>transport.channelInfo!(id,signal)}});
          sharedConversation={...base,async respond(...args){
            if(engineering?.busy())return;
            conversationDispatches++;try{await base.respond(...args);}finally{conversationDispatches--;flushEngineeringStarts();}
          }};
        }catch{log.warn('shared conversation unavailable',{reason:'shared_runtime_initialization_rejected'});}
      }
      if(alertConfig){
        alertDb=openSlackAlertDatabase(alertConfig);
        alertIntake=createSlackAlertIntake({db:alertDb,transport,producer:alertConfig.producer,mode:alertConfig.mode});
      }
      let engineeringHealth:(()=>boolean)|undefined;
      if(engineeringConfig){
        const pinned=engineeringConfig;
        const assertPinned=()=>{
          if(controller.signal.aborted)throw new Error('engineering_host_stopped');
          const current=loadEngineeringRuntimeConfig(host.engineeringConfigPath!,host.engineeringConfigSha256!,host.engineeringAuthorityReceiptPath!,host.engineeringAuthorityReceiptSha256!);
          if(current.sourceRevision!==host.conversationRuntimeRelease)throw new Error('engineering_source_release_mismatch');
        };
        const ledgerPath=resolve(cfg.gary.stateDir,'spend.db');
        if(realpathSync(ledgerPath)!==ledgerPath||lstatSync(ledgerPath).isSymbolicLink())throw new Error('engineering_canonical_ledger_rejected');
        const binding:EngineeringBudgetBinding={aggregatePath:pinned.budget.aggregatePath,auditDir:pinned.budget.auditDir,runId:pinned.budget.runId,
          ledgerPath,grantId:pinned.grantId,campaignId:pinned.campaignId,
          allocationId:pinned.allocationId,sourceRevision:pinned.sourceRevision,runtimeConfigSha256:host.engineeringConfigSha256!,authoritySha256:host.engineeringAuthorityReceiptSha256!};
        const budget=deps.engineering?.assertBudget??assertEngineeringBudgetAdmission;
        const continuation=deps.engineering?.assertContinuation??assertEngineeringContinuationBudget;
        const continuationBinding:EngineeringContinuationBinding|undefined=pinned.budget.continuation
          ? {...binding,root:pinned.root,workspacesRoot:pinned.workspacesRoot,continuation:pinned.budget.continuation}:undefined;
        if(continuationBinding&&continuationBinding.continuation.original.ledgerPath!==ledgerPath)throw new Error('engineering_continuation_ledger_mismatch');
        const continuationBaseline=continuationBinding?continuation(continuationBinding,{requireUnused:false}):undefined;
        if(!continuationBinding)budget(binding,{requireUnused:false});
        engineeringDb=openEngineeringJournal(join(pinned.root,'engineering.sqlite'));
        engineeringSpendDb=new Database(ledgerPath,{readonly:true,strict:true,create:false});
        if(cfg.github.kind!=='app')throw new Error('engineering_github_app_required');
        const appBinding={appId:Number(cfg.github.appId),installationId:Number(cfg.github.installationId)};
        const repository=createEngineeringGitHubRepositoryServices({client:github,binding:appBinding,fetch:rawFetch});
        engineering=(deps.engineering?.createRuntime??createEngineeringRuntime)({config:pinned,journalDb:engineeringDb,spendDb:engineeringSpendDb,ledger:spend,
          ...(continuationBaseline?{continuationBaseline}:{}),
          repository:{binding:appBinding,...repository},providerApiKey:providerConfigs[0]!.apiKey,fetch:request=>rawFetch(request),
          assertGrant:()=>{assertPinned();if(continuationBaseline)continuationBaseline.assertCurrent();else budget(binding,{requireUnused:false});},assertRuntime:assertPinned,assertBudget:()=>{
            assertPinned();if(legacyDispatches||conversationDispatches)throw new Error('engineering_host_dispatch_busy');
            if(continuationBinding)continuation(continuationBinding,{requireUnused:true});else budget(binding,{requireUnused:true});
          },
          deliver:receipt=>slack?.deliverEngineeringReceipt(receipt)??Promise.resolve('not_sent')});
        engineeringHealth=()=>{try{assertPinned();return true;}catch{return false;}};
        if(!engineering.ready())throw new Error('engineering_runtime_reconciliation_required');
        log.info('engineering runtime ready',{release:pinned.sourceRevision,configSha256:host.engineeringConfigSha256,
          grantId:pinned.grantId,allocationId:pinned.allocationId,capMicros:pinned.capMicros,publication:'patch_only',ready:true});
      }
      if(standingConfig){
        const pinned=standingConfig;
        const assertPinned=()=>{
          if(controller.signal.aborted)throw new Error('standing_engineering_stopped');
          const current=loadStandingEngineeringConfig(host.standingEngineeringConfigPath!,host.standingEngineeringConfigSha256!,
            host.standingEngineeringAuthorityPath!,host.standingEngineeringAuthoritySha256!);
          if(current.sourceRevision!==host.conversationRuntimeRelease)throw new Error('standing_engineering_source_release_mismatch');
        };
        const ledgerPath=resolve(cfg.gary.stateDir,'spend.db');
        if(realpathSync(ledgerPath)!==ledgerPath||lstatSync(ledgerPath).isSymbolicLink()
          ||overlappingRoots(pinned.workspacesRoot,ledgerPath)||overlappingRoots(pinned.root,ledgerPath)||pinned.routine&&overlappingRoots(pinned.routine.scopedRoot,ledgerPath))throw new Error('standing_engineering_canonical_ledger_rejected');
        const assertFunding=createStandingEngineeringFundingGuard({
          authority:pinned.funding,fundingAuthorityPath:pinned.fundingAuthorityPath,
          fundingHoldReceiptPath:pinned.fundingHoldReceiptPath,aggregatePath:pinned.aggregatePath,ledgerPath,
        });
        standingBudget=createStandingEngineeringBudget({ledger:spend,authority:pinned.funding,terminalJournalPath:join(pinned.root,'engineering.sqlite'),
          assertAuthority:()=>{assertPinned();assertFunding();}});
        // Startup observes explicit enrollment; it cannot create or borrow funds.
        const assertBudget=()=>{if(!standingBudget!.status().enrolled)throw new Error('standing_engineering_funding_not_enrolled');};
        assertBudget();
        engineeringDb=openEngineeringJournal(join(pinned.root,'engineering.sqlite'));
        engineeringSpendDb=new Database(ledgerPath,{readonly:true,strict:true,create:false});
        if(cfg.github.kind!=='app')throw new Error('engineering_github_app_required');
        const appBinding={appId:Number(cfg.github.appId),installationId:Number(cfg.github.installationId)};
        const repository=createEngineeringGitHubRepositoryServices({client:github,binding:appBinding,fetch:rawFetch});
        if(pinned.routine)routineServices=(deps.engineering?.createRoutine??openEngineeringRoutineServices)({
          config:pinned.routine,ledger:spend,assertCurrent:()=>{assertPinned();assertFunding();}});
        engineering=(deps.engineering?.createRuntime??createEngineeringRuntime)({config:pinned,journalDb:engineeringDb,
          ...(routineServices?{routine:routineServices}:{}),spendDb:engineeringSpendDb,ledger:spend,standing:{budget:standingBudget,
            resolveBase:resolution=>resolveEngineeringDefaultBase({resolution,getCredential:repository.getCredential,fetch:rawFetch})},
          repository:{binding:appBinding,...repository},providerApiKey:providerConfigs[0]!.apiKey,fetch:request=>rawFetch(request),
          assertGrant:()=>{assertPinned();assertFunding();},assertRuntime:assertPinned,
          assertBudget:()=>{assertBudget();if(legacyDispatches)throw new Error('standing_engineering_legacy_dispatch_busy');},
          assertExecutionReady:()=>{if(legacyDispatches||conversationDispatches)throw new Error('standing_engineering_conversation_not_drained');},
          deliver:receipt=>slack?.deliverEngineeringReceipt(receipt)??Promise.resolve('not_sent')});
        engineeringHealth=()=>{try{assertPinned();assertFunding();return true;}catch{return false;}};
        if(!engineering.ready())throw new Error('standing_engineering_reconciliation_required');
        log.info('standing engineering runtime ready',{grantId:pinned.grantId,publication:pinned.publication,
          poolId:pinned.funding.poolId,ready:true});
      }
      slack = createSlackService({ db, transport, onIngressDiagnostic:logSlackIngressDiagnostic, checkHostHealth: readiness.check, approvedChannelIds: host.slack.approvedChannelIds,
        ...(conversation?{conversation,tannerDirectMessages:true as const}:{}),...(sharedConversation?{sharedConversation}:{}),
        ...(alertIntake?{alertIntake}:{}),
        ...(engineering?{engineeringIngress:standingConfig?{...engineering.ingress,start(receipt:EngineeringReceipt){
          // The service verifies before requesting wake; host.start rechecks
          // the exact durable receipt when the shared conversation slot drains.
          pendingEngineeringStarts.set(receipt.taskId,receipt);flushEngineeringStarts();
        }}:engineering.ingress,checkEngineeringHealth:engineeringHealth!,checkConversationAdmission:()=>!engineering!.busy()}:{}),
        ...(standingConfig?{standingEngineeringEnabled:true as const}:{}),
        ...(host.conversationRuntimeRelease?{checkConversationHealth:()=>!controller.signal.aborted}: {}) });
      const health = await slack.start();
      if (controller.signal.aborted) return;
      if (!health.running || !health.identityVerified || !health.socketHealthy) throw new Error('slack_startup_health_failed');
      if(alertConfig&&alertIntake){
        log.info('alert runtime ready',{mode:alertConfig.mode,configFingerprint:alertConfig.fingerprint,release:host.conversationRuntimeRelease,modelCalls:false});}
      if(conversationConfig&&conversation){if(!conversation.ready())throw new Error('dm_conversation_not_ready');
        log.info('conversation runtime ready',{kind:'private_dm',runId:conversationConfig.runId,allocationId:conversationConfig.allocationId,
          configFingerprint:fingerprintSlackConversationConfig(conversationConfig),release:host.conversationRuntimeRelease,tools:projects?'project-assistant-v1':'none'});}
      if(sharedConfig&&sharedConversation)log.info('conversation runtime ready',{kind:'shared_channel',ready:sharedConversation.ready(),runId:sharedConfig.runId,
        allocationId:sharedConfig.allocationId,configFingerprint:fingerprintSlackSharedConversationConfig(sharedConfig),release:host.conversationRuntimeRelease,tools:projects?'project-assistant-v1':'none',trigger:'explicit_mention'});
    }
    recordEvent(db, { eventType: 'boot', payload: { version: '0.0.1', runtime: host.mode } });
    log.info('gary booted', { name: cfg.gary.name, dbPath: cfg.gary.dbPath, githubAuth: cfg.github.kind,
      providers: chain.providers.map(provider => `${provider.name}:${provider.model}`), runtime: host.mode,
      canaryIssueId: activationConfig?.issueId ?? null, slack: slack ? 'connected' : 'disabled', pollIntervalMs: cfg.runtime.pollIntervalMs });
    await (deps.runLoop ?? runLoop)({ db, spend, linear, github, glm, cloudflare,
      ...(engineering?{beginDispatch:()=>{
        if(controller.signal.aborted||engineering!.busy())return null;
        legacyDispatches++;let released=false;return()=>{if(!released){released=true;legacyDispatches--;flushEngineeringStarts();}};
      }}:{}),
      wake:loopWake,onTickState:state=>{loopState=controller.signal.aborted?'stopped':state;},
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
      // Abort first, then drain both sandboxes/guardians before any canonical or
      // private database handle can close underneath a late completion.
      await engineering?.stop();
      routineServices?.close();
      standingBudget?.close();
      engineeringSpendDb?.close();engineeringDb?.close();
      try {
        try{if(conversation)log.info('conversation runtime stopped',{kind:'private_dm',drained:conversation.close().drained});}
        finally{if(sharedConversation)log.info('conversation runtime stopped',{kind:'shared_channel',drained:sharedConversation.close().drained});}
      } finally {try {
        if(alertIntake){alertIntake.close();const drain=await alertIntake.drain();
          log.info('alert runtime stopped',{drained:drain.drained});
          // A timed out operation retains its durable stop. Do not close its
          // handle underneath a late completion; process exit releases it.
          if(drain.drained)alertDb?.close();
        }else alertDb?.close();
      } finally {try { projects?.close(); } finally {try { executorJobJournal?.close(); } finally { try { spend?.close(); } finally { db.close(); } }}}}
    }
  }
}
