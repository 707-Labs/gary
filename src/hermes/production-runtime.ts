/** Optional production composition. Construction never starts a process or changes a ledger. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentLoopArgs, AgentLoopResult } from '../agent/loop.ts';
import type { AdmittedCodeLoopRunner } from '../handlers/code.ts';
import type { CodeActionAdmission } from './canonical-admission.ts';
import { createGaryPhaseCoordinator } from './phase-coordinator.ts';
import type { GaryRuntimeLauncher } from './gary-loop-adapter.ts';
import type { AdmittedSession, SessionOptions } from './session-host.ts';
import { createProductionEvidence } from './production-evidence.ts';
import type { ContextTaskDefinition, InstructionSource } from './task-context.ts';
import type { ProgressPolicy } from './progress-guard.ts';
import type { AuditTrace, AuditTraceBinding } from './audit-trace.ts';
import type { ScopedIntegrationBindings } from './scoped-integrations.ts';
import { EXECUTOR_TOOL_NAMES } from './executor-bridge.ts';
import { createReadonlyChildExecutor } from './readonly-child.ts';

export interface ProductionTaskPolicy {
  /** Authoritative criteria and exact allowed files supplied by the host. */
  task: Omit<ContextTaskDefinition, 'taskId'>;
  baseCommit: string;
  progress: ProgressPolicy;
  instructions: readonly InstructionSource[];
  voicePrinciples: string;
  readTicketIdentifiers: readonly string[];
  publicFetch: NonNullable<ScopedIntegrationBindings['publicFetch']>;
  cloudflare?: { allowedServices: readonly string[]; allowedDatabases: readonly string[] };
  /** Runs once, in the existing executor, with pipefail and the original absolute deadline. */
  preparationCommands?: readonly string[];
}
export interface ProductionRuntimeOptions {
  /** Explicit already-approved route; must equal the dispatch action's provider/model. */
  route: Pick<SessionOptions, 'provider' | 'model' | 'providerApiKey' | 'fetch'>;
  /** Host-selected DeepSeek policy; never inferred from agent arguments or native messages. */
  thinking?: 'disabled';
  taskPolicy(admission: CodeActionAdmission, args: AgentLoopArgs): ProductionTaskPolicy | Promise<ProductionTaskPolicy>;
  /** Must create a fresh isolated worker for every invocation, including phases and children. */
  launch: GaryRuntimeLauncher;
  /** Operator owns private trace location and permissions. Each call creates a fresh trace. */
  createTrace(binding: AuditTraceBinding): AuditTrace;
  /** Explicit opt-in to depth-one read-only children using an existing immutable executor image. */
  readonlyChildren?: { imageDigest: string; dockerExecutable?: string; dockerHost?: string };
}

function failed(message: string): AgentLoopResult {
  return { status:'error', summary:null, iterations:0, inputTokens:0, outputTokens:0,
    cacheCreationTokens:0, cacheReadTokens:0, phase:'hermes', runLog:[], errorMessage:message };
}
function grantedTools(bindings: ScopedIntegrationBindings, readOnly = false): string[] {
  const names: string[] = EXECUTOR_TOOL_NAMES.filter(name => !readOnly || !['write_file','edit_file','commit','finish'].includes(name));
  if (bindings.publicFetch) names.push('fetch_url');
  if (bindings.linear) {
    names.push('get_linear_issue');
    if (!readOnly && bindings.linear.currentIssue) names.push('unassign_self','set_ticket_state','update_ticket_description');
  }
  if (bindings.github) names.push('get_pr');
  if (bindings.cloudflare?.allowedServices.length) names.push('query_cloudflare_logs','list_cloudflare_invocations');
  if (bindings.cloudflare?.allowedDatabases.length) names.push('d1_query');
  if (!readOnly && bindings.subagentRunner) names.push('dispatch_subagent');
  return names;
}

const boundActions = new WeakSet<CodeActionAdmission>();

/** Plug into LoopDeps.createAdmittedCodeLoop. This factory never polls or enrolls tickets. */
export function createHermesCodeLoopFactory(options: ProductionRuntimeOptions): (action: CodeActionAdmission) => AdmittedCodeLoopRunner {
  const thinking = options.thinking;
  if (thinking !== undefined && (thinking !== 'disabled' || options.route.provider !== 'deepseek')) throw new Error('invalid_host_thinking_policy');
  options = {...options,route:Object.freeze({...options.route}),
    ...(options.readonlyChildren ? {readonlyChildren:Object.freeze({...options.readonlyChildren})} : {})};
  return action => {
    action.assertActive();
    if (action.provider !== options.route.provider || action.model !== options.route.model) throw new Error('admitted_model_route_mismatch');
    if (boundActions.has(action)) throw new Error("production_action_already_bound");
    boundActions.add(action);
    const taskId = `gary-action-${action.actionId}`;
    let busy = false, stopped = false;
    let policy: ProductionTaskPolicy | undefined;
    let evidence: Awaited<ReturnType<typeof createProductionEvidence>> | undefined;
    let workspaceRoot: string | undefined, deadlineMs: number | undefined;
    const active = () => { if (stopped) throw new Error('production_runtime_stopped'); action.assertActive(); };
    return async args => {
      if (busy || stopped) return failed(busy ? 'concurrent_code_loop_rejected' : 'production_runtime_stopped');
      busy = true;
      let trace: AuditTrace | undefined, traceHandedOff = false;
      let stage = "admission";
      try {
        active();
        const incomingDeadline = Math.min(args.deadlineMs ?? Infinity, Date.now() + args.timeoutMs);
        if (!Number.isFinite(incomingDeadline) || incomingDeadline <= Date.now()) return failed('invalid_production_deadline');
        if (workspaceRoot !== undefined && (workspaceRoot !== args.executor.workspaceRoot || incomingDeadline > deadlineMs!)) {
          throw new Error('production_binding_changed');
        }
        workspaceRoot ??= args.executor.workspaceRoot;
        deadlineMs = Math.min(deadlineMs ?? Infinity, incomingDeadline);
        if (args.currentIssue && (args.currentIssue.id !== action.issue.id || args.currentIssue.identifier !== action.issue.identifier
          || args.currentIssue.teamId !== action.issue.teamId)) throw new Error('canonical_ticket_scope_mismatch');
        if (args.defaultRepo !== undefined && args.defaultRepo !== action.repo) throw new Error('canonical_repository_scope_mismatch');
        stage = "policy";
        if (!policy) {
          const selected = await options.taskPolicy(action, args); active();
          const { publicFetch, ...data } = selected;
          policy = {...structuredClone(data), publicFetch:{policy:structuredClone(publicFetch.policy),
            ...(publicFetch.transport ? {transport:publicFetch.transport} : {})}};
          if (!args.finishGateCommand || !policy.task.criteria.some(c => c.requiredCommands.includes(args.finishGateCommand!))) {
            throw new Error('canonical_finish_check_missing');
          }
        }
        const readonlyPhaseAllowance = args.phases?.slice(0,-1).reduce((sum,phase)=>sum+phase.maxIter,0) ?? 0;
        if (readonlyPhaseAllowance >= policy.progress.maxModelRequestsWithoutProgress
          || (args.phases?.reduce((sum,phase)=>sum+phase.maxIter,0) ?? args.maxIterations) > policy.progress.maxModelRequests) {
          throw new Error('progress_policy_conflicts_with_phase_budget');
        }
        const admission: AdmittedSession = { taskId, requestId:randomUUID(), ticketId:action.ticketId,
          actionId:action.actionId, fingerprint:action.fingerprint, ownerEpoch:action.ownerEpoch, deadlineMs };
        const assertAdmission = (supplied: Readonly<AdmittedSession>) => {
          active();
          if (['taskId','ticketId','actionId','fingerprint','ownerEpoch'].some(key => supplied[key as keyof AdmittedSession] !== admission[key as keyof AdmittedSession])
            || supplied.deadlineMs > admission.deadlineMs) throw new Error('production_admission_mismatch');
        };
        const traceBinding = (session: AdmittedSession): AuditTraceBinding => ({taskId:session.taskId,requestId:session.requestId,
          ticketId:session.ticketId,actionId:session.actionId,ownerEpoch:session.ownerEpoch});
        stage = "trace";
        trace = options.createTrace(traceBinding(admission));
        stage = "evidence";
        if (evidence) await evidence.invalidateVerification();
        if (!evidence) {
          evidence = await createProductionEvidence({ executor:args.executor,
            scope:{taskId,workspaceId:taskId,ownerEpoch:action.ownerEpoch,allocationId:action.ticketId},
            task:{...policy.task,taskId}, baseCommit:policy.baseCommit, voicePrinciples:policy.voicePrinciples,
            instructions:policy.instructions, policy:policy.progress, deadlineMs, assertAdmission:active,
            ...(args.signal ? {signal:args.signal} : {}),
            allocationState:()=>action.ledger.status(action.ticketId)?.state === 'active' ? 'active'
              : action.ledger.status(action.ticketId)?.state === 'exhausted' ? 'exhausted' : 'closed' });
          active();
          if (policy.preparationCommands?.length) await evidence.runPreparation(policy.preparationCommands, args.signal);
          active();
        }
        stage = "integrations";
        const integrations: ScopedIntegrationBindings = { publicFetch:policy.publicFetch };
        if (args.linear) integrations.linear = { client:args.linear, readIdentifiers:policy.readTicketIdentifiers,
          ...(args.currentIssue ? {currentIssue:args.currentIssue} : {}) };
        if (args.github && args.defaultRepo) integrations.github = {client:args.github, defaultRepo:args.defaultRepo};
        if (args.cloudflare) {
          if (!policy.cloudflare) throw new Error('canonical_cloudflare_scope_missing');
          integrations.cloudflare = {client:args.cloudflare,...policy.cloudflare};
        }
        if (args.disableSubagent !== true) {
          if (!options.readonlyChildren) throw new Error('readonly_child_executor_required');
          integrations.subagentRunner = async (task, parentSignal) => {
            active();
            const childSignals = [args.signal,parentSignal].filter((signal):signal is AbortSignal=>signal !== undefined);
            const childSignal = childSignals.length ? AbortSignal.any(childSignals) : undefined;
            const counters=evidence!.progress.state.counters;
            const childIterations=Math.min(15,policy!.progress.maxModelRequests-counters.modelRequests-1,
              policy!.progress.maxModelRequestsWithoutProgress-counters.requestsWithoutProgress-1);
            if (childIterations < 1) return {status:'blocked',summary:'No remaining shared investigation allowance for a child.',iterations:0};
            const child = await createReadonlyChildExecutor({ ...options.readonlyChildren!, workspaceRoot:workspaceRoot!,
              admission, parentDepth:0, assertActive:assertAdmission, ...(childSignal ? {signal:childSignal} : {}) });
            let childTrace: AuditTrace | undefined, handedOff = false;
            try {
              active();
              const childAdmission = {...admission, requestId:randomUUID()};
              const childBindings: ScopedIntegrationBindings = {
                ...(integrations.publicFetch ? {publicFetch:integrations.publicFetch} : {}),
                ...(integrations.linear ? {linear:{client:integrations.linear.client,readIdentifiers:integrations.linear.readIdentifiers}} : {}),
                ...(integrations.github ? {github:integrations.github} : {}),
                ...(integrations.cloudflare ? {cloudflare:integrations.cloudflare} : {}),
              };
              childTrace = options.createTrace(traceBinding(childAdmission));
              let prose: string | null = null;
              const launch: GaryRuntimeLauncher = async (...launchArgs) => {
                const result = await options.launch(...launchArgs);
                prose = typeof result.text === 'string' ? result.text : null;
                return result;
              };
              stage = "coordinator";
        const run = createGaryPhaseCoordinator({baseUrl:'http://127.0.0.1/',launch,prepareManifest:evidence!.prepareManifest,hostOptions:{
                ...options.route,...(thinking === undefined ? {} : {thinking}),admission:childAdmission,capabilityToken:randomBytes(32).toString('hex'),ledger:action.ledger,
                executor:child.executor,readOnly:true,integrations:childBindings,allowedTools:grantedTools(childBindings,true),
                finishGateCommand:'',currentOwnerEpoch:()=>{active();return action.ownerEpoch;},assertAdmission,
                trace:childTrace,progress:evidence!.progress,...(childSignal ? {signal:childSignal} : {}),
              }});
              const {phases:_phases,finishGateCommand:_finish,currentIssue:_issue,...baseArgs} = args;
              handedOff = true;
              const result = await run({...baseArgs,executor:child.executor,task,systemPrompt:args.systemPrompt + '\n\nRead-only investigation. Report evidence and limitations. Do not delegate or publish.',
                maxIterations:childIterations,timeoutMs:Math.min(300_000,deadlineMs!-Date.now()),deadlineMs:deadlineMs!,disableSubagent:true,readOnly:true,
                ...(childSignal ? {signal:childSignal} : {})});
              if (result.status === 'error' || result.status === 'timeout' || childTrace.failed) {
                stopped = true;
                throw new Error('child_runtime_failed');
              }
              active();
              return {status:result.status,summary:['no_finish','finished'].includes(result.status) ? prose : result.summary,iterations:result.iterations};
            } finally {
              try {
                if (childTrace && !handedOff && !childTrace.failed) { childTrace.append({kind:'terminal',status:'error',iteration:0,phase:'hermes',
                  modelState:{provider:options.route.provider,model:options.route.model,thinking:thinking ?? 'unknown',effort:'unknown'},errorCode:'native_runtime_error'});childTrace.close(); }
              } finally {
                try { await child.close(); } catch { stopped=true;throw new Error('child_cleanup_failed'); }
              }
            }
          };
        }
        active();
        stage = "coordinator";
        const run = createGaryPhaseCoordinator({baseUrl:'http://127.0.0.1/',launch:options.launch,prepareManifest:evidence.prepareManifest,hostOptions:{
          ...options.route,...(thinking === undefined ? {} : {thinking}),admission,capabilityToken:randomBytes(32).toString('hex'),ledger:action.ledger,
          assertFinishEvidence:async signal=>{
            const context=await evidence!.contextSnapshot(signal);active();
            if (!context.acceptance.scopeWithinAllowedFiles || context.acceptance.openBlockers.length
              || context.acceptance.criteria.some(criterion=>criterion.testEvidence !== 'satisfied')) {
              throw new Error('canonical_acceptance_incomplete');
            }
          },
          executor:evidence.executor,integrations,allowedTools:grantedTools(integrations),finishGateCommand:args.finishGateCommand!,
          currentOwnerEpoch:()=>{active();return action.ownerEpoch;},assertAdmission,trace,progress:evidence.progress,
          ...(args.signal ? {signal:args.signal} : {}),
        }});
        traceHandedOff = true;
        const result = await run({...args,executor:evidence.executor,deadlineMs});
        if (result.status === 'error' || result.status === 'timeout' || action.ledger.status(action.ticketId)?.state !== 'active') stopped = true;
        return result;
      } catch {
        stopped = true;
        return failed(action.ledger.status(action.ticketId)?.state === 'exhausted' ? 'budget_exhausted' : 'production_runtime_failed:' + stage);
      } finally {
        busy = false;
        if (trace && !traceHandedOff && !trace.failed) {
          try { trace.append({kind:'terminal',status:'error',iteration:0,phase:'hermes',modelState:{provider:options.route.provider,
            model:options.route.model,thinking:thinking ?? 'unknown',effort:'unknown'},errorCode:'native_runtime_error'});trace.close(); } catch { stopped = true; }
        }
      }
    };
  };
}
