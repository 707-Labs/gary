/** Host-owned execution boundary for the native delegation/code handlers.
 * Construction is inert. Callers supply confined execution; no worker argument
 * can choose a path, model route, audience, allocation, deadline or child ID. */
import { randomUUID } from 'node:crypto';
import { fingerprintJson } from './audit-trace.ts';
import type { EngineeringProtocolBinding } from './engineering-protocol.ts';

type Json = Record<string, unknown>;
export interface EngineeringTaskToolCall {
  toolCallId: string; admissionId: string; toolName: string;
  originalArgs: Readonly<Json>;
}
export interface EngineeringTaskToolScope extends EngineeringProtocolBinding {
  scopeKey: string; allocationId: string; delegationDepth: 0 | 1;
}
export interface EngineeringChildRequest {
  readonly scope: Readonly<EngineeringTaskToolScope>;
  readonly childId: string;
  readonly ordinal: 1 | 2;
  readonly taskIndex: 0 | 1;
  readonly delegationDepth: 1;
  readonly goal: string;
  readonly context: string | null;
}
export interface EngineeringCodeRequest {
  readonly scope: Readonly<EngineeringTaskToolScope>;
  readonly code: string;
  /** Nested calls inherit this one observed code call; they are not new model
   * observations. The confined runner must mint/consume a one-use call ID for
   * each, reject all other tools and keep the same executor/audience/budget. */
  readonly allowedTools: readonly string[];
  readonly parentCall: Readonly<EngineeringTaskToolCall>;
}
export interface EngineeringTaskToolOptions {
  scope: EngineeringTaskToolScope;
  signal: AbortSignal;
  allowedCodeTools: readonly string[];
  assertOwner(): void;
  fence(reason: string): void;
  /** The callback owns a distinct writable clone, a metered native child and
   * serialized artifact integration. It returns only after all child writers
   * are absent. Children share the exact parent's allocation and deadline. */
  runChild(request: EngineeringChildRequest, signal: AbortSignal): Promise<{ result: Json; cleanupConfirmed: true }>;
  /** Execute only in the admitted project sandbox, never a host subprocess.
   * Drain its process before returning. The host supplies nested capabilities. */
  runCode(request: EngineeringCodeRequest, signal: AbortSignal): Promise<{ result: Json; cleanupConfirmed: true }>;
  now?: () => number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CODE_TOOLS = new Set(['terminal','read_file','write_file','patch','search_files']);
function fail(reason: string): never { throw new Error('engineering_task_tools:' + reason); }
function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exact(value: Json, keys: string[]) { if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) fail('arguments'); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && !value.includes('\0') && Buffer.byteLength(value)<=max; }
function identity(value: unknown) { if (typeof value!=='string'||value.length>192||!ID.test(value)||value.trim()!==value) fail('identity'); }

export function createEngineeringTaskTools(options: EngineeringTaskToolOptions) {
  const scope=Object.freeze({...options.scope}), allowedTools=Object.freeze([...options.allowedCodeTools]);
  for (const value of [scope.taskId,scope.sessionId,scope.ownerEpoch,scope.scopeKey,scope.allocationId]) identity(value);
  if (![0,1].includes(scope.delegationDepth)||!Number.isSafeInteger(scope.deadlineMs)
      ||new Set(allowedTools).size!==allowedTools.length||allowedTools.some(t=>!CODE_TOOLS.has(t))) fail('configuration');
  const consumed=new Set<string>(), children=new Set<string>();
  let busy=false,fenced=false;
  const guard=()=>{if(fenced)fail('fenced');options.signal.throwIfAborted();options.assertOwner();
    if((options.now??Date.now)()>=scope.deadlineMs)fail('deadline');};
  return Object.freeze({
    async execute(operation: string, raw: Readonly<Json>, context: EngineeringTaskToolCall): Promise<Json> {
      guard();if(busy)fail('concurrent_operation');
      const args=structuredClone(raw),call=structuredClone(context);
      if(!object(args)||!object(call.originalArgs))fail('arguments');
      identity(args.operationId);identity(call.toolCallId);identity(call.admissionId);
      if(consumed.has(String(args.operationId))||consumed.size>=100)fail('operation_replayed_or_limit');
      let child: EngineeringChildRequest|undefined,code: EngineeringCodeRequest|undefined;
      if(operation==='delegate.run'){
        exact(args,['operationId','taskIndex','goal','context']);
        if(call.toolName!=='delegate_task'||scope.delegationDepth!==0||!Number.isSafeInteger(args.taskIndex)
            ||Number(args.taskIndex)<0||Number(args.taskIndex)>1||!text(args.goal,32_768)
            ||args.context!==null&&!text(args.context,65_536))fail('delegation_scope');
        const original=call.originalArgs;
        // Async/control/orchestrator modes and requested alternate models are
        // not part of this synchronous one-level native profile.
        if(Object.keys(original).some(k=>!['goal','context','tasks','max_iterations','role'].includes(k))
            ||original.role!==undefined&&original.role!=='leaf')fail('delegation_mode');
        const tasks=original.tasks===undefined?[{goal:original.goal,context:original.context}]:original.tasks;
        if(!Array.isArray(tasks)||tasks.length<1||tasks.length>2||original.tasks!==undefined&&(original.goal!==undefined||original.context!==undefined))fail('delegation_tasks');
        const task=tasks[Number(args.taskIndex)];
        if(!object(task)||Object.keys(task).some(k=>!['goal','context','role'].includes(k))
            ||task.role!==undefined&&task.role!=='leaf'||task.goal!==args.goal||(task.context??null)!==args.context)fail('delegation_request_changed');
        const key=call.toolCallId+':'+args.taskIndex;
        if(children.has(key)||children.size>=2)fail('child_replayed_or_limit');
        children.add(key);
        child=Object.freeze({scope,childId:'engineering-child-'+randomUUID(),ordinal:children.size as 1|2,
          taskIndex:args.taskIndex as 0|1,delegationDepth:1,goal:args.goal,context:args.context as string|null});
      }else if(operation==='code.run'){
        exact(args,['operationId','code']);
        if(call.toolName!=='execute_code'||!text(args.code,262_144)||call.originalArgs.code!==args.code
            ||Object.keys(call.originalArgs).some(k=>k!=='code'))fail('code_request_changed');
        code=Object.freeze({scope,code:args.code,allowedTools,parentCall:Object.freeze({...call,originalArgs:Object.freeze(call.originalArgs)})});
      }else fail('operation');
      consumed.add(String(args.operationId));busy=true;
      try {
        const output=child?await options.runChild(child,options.signal):await options.runCode(code!,options.signal);
        guard();
        if(!object(output)||output.cleanupConfirmed!==true||!object(output.result)||fingerprintJson(output.result).bytes>262_144)fail('result_or_cleanup');
        return {result:structuredClone(output.result)};
      }catch(error){fenced=true;options.fence('native_task_operation_uncertain');throw error;}
      finally{busy=false;}
    },
  });
}
