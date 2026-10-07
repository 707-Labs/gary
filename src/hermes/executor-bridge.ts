/** Task-scoped Hermes bridge to Gary's existing tools. No native Hermes executor. */
import { createHash, timingSafeEqual } from "node:crypto";
import { makeToolset, type AgentTools, type TodoItem } from "../agent/tools.ts";
import type { RunLogEntry } from "../agent/loop.ts";
import { createDeadline } from "../deadline.ts";
import type { Executor } from "../executors/index.ts";
import { bindScopedIntegrations, type ScopedIntegrationBindings } from './scoped-integrations.ts';

export const EXECUTOR_TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "grep", "list_files", "run_bash",
  "commit", "todo_write", "finish", "report_blocked",
] as const;
export type ExecutorToolName = typeof EXECUTOR_TOOL_NAMES[number];

export interface TaskCapability {
  taskId: string;
  token: string;
  ownerEpoch: string;
  deadlineMs: number;
}

export interface ExecutorBridgeOptions {
  /** The trusted host supplies the already isolated Gary Executor. */
  executor: Executor;
  capability: TaskCapability;
  currentOwnerEpoch: () => string;
  isCapabilityActive?: () => boolean;
  /** Explicit subset only; omitted or unknown names fail closed. */
  allowedTools: readonly string[];
  finishGateCommand: string;
  /** Explicit host-owned integrations; no credentials enter tool schemas. */
  integrations?: ScopedIntegrationBindings;
  /** Read-only child runs omit all file and current-ticket mutation handlers. */
  readOnly?: boolean;
  /** Fresh canonical acceptance evidence, checked before granting finish. */
  assertFinishEvidence?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  maxResultBytes?: number;
  maxInputBytes?: number;
  maxCalls?: number;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolInvocation {
  taskId: string;
  token: string;
  ownerEpoch: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface BridgeState {
  finishSummary: string | null;
  blockedReason: string | null;
  finishGateMet: boolean;
  readCache: string[];
  todos: TodoItem[];
  runLog: RunLogEntry[];
  invalidated: boolean;
}

export interface ToolInvocationResult {
  ok: boolean;
  tool_call_id: string;
  name: string;
  content: string;
  error?: string;
  truncated: boolean;
  /** Full run log stays with the trusted host through bridge.state. */
  state: Pick<BridgeState, "finishSummary" | "blockedReason" | "finishGateMet" | "invalidated"> & { runLogCount: number };
}

export interface ExecutorBridge {
  readonly definitions: OpenAIToolDefinition[];
  /** Detached snapshot, never a reference to mutable AgentTools/handlers. */
  readonly state: BridgeState;
  invoke(request: unknown): Promise<ToolInvocationResult>;
  dispose(): void;
}

class BridgeFault extends Error {
  constructor(readonly code: string) { super(code); }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const digest = (value: string) => createHash("sha256").update(value).digest();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function boundedText(value: string, bytes: number): string {
  const raw = Buffer.from(value);
  return raw.length <= bytes ? value : new TextDecoder().decode(raw.subarray(0, bytes), { stream: true });
}

function workspacePath(path: unknown, glob = false): void {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\\]/.test(path)
      || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some(part => part === "..")
      // Keep glob expressions from hiding traversal components in brace alternatives.
      || (glob && (path.includes("..") || path.startsWith("!")))) {
    throw new BridgeFault("path_denied");
  }
}

export function createExecutorBridge(options: ExecutorBridgeOptions): ExecutorBridge {
  const capability = Object.freeze({ ...options.capability });
  if (!ID.test(capability.taskId) || !ID.test(capability.ownerEpoch)
      || typeof capability.token !== "string" || capability.token.length < 32 || capability.token.length > 512
      || !Number.isFinite(capability.deadlineMs)
      || (!options.finishGateCommand?.trim() && !(options.readOnly === true && Array.isArray(options.allowedTools) && !options.allowedTools.includes('finish')))) {
    throw new Error("invalid task capability or verification command");
  }
  const limits = {
    result: options.maxResultBytes ?? 16_384,
    input: options.maxInputBytes ?? 262_144,
    calls: options.maxCalls ?? 2048,
  };
  if (!Number.isSafeInteger(limits.result) || limits.result < 1024 || limits.result > 1_048_576
      || !Number.isSafeInteger(limits.input) || limits.input < 1024 || limits.input > 1_048_576
      || !Number.isSafeInteger(limits.calls) || limits.calls < 1 || limits.calls > 100_000) {
    throw new Error("invalid bridge limits");
  }
  if (!Array.isArray(options.allowedTools) || new Set(options.allowedTools).size !== options.allowedTools.length) {
    throw new Error("explicit supported tool allowlist required");
  }
  const allowed = new Set(options.allowedTools);
  const tokenDigest = digest(capability.token);
  const cancellation = new AbortController();
  const deadline = createDeadline({ deadlineMs: capability.deadlineMs,
    signal: options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal });
  const runLog: RunLogEntry[] = [];
  const calls = new Set<string>();
  let tools: AgentTools;
  let invalidated = false;
  let disposed = false;
  let busy = false;
  let executorFailed = false;

  function invalidate(code: string): never {
    invalidated = true;
    cancellation.abort();
    if (tools) {
      tools.finishSummary = null;
      tools.blockedReason = null;
      tools.finishGateMet = false;
    }
    throw new BridgeFault(code);
  }
  function live(): void {
    if (disposed || invalidated) throw new BridgeFault("capability_inactive");
    try {
      if (options.currentOwnerEpoch() !== capability.ownerEpoch || options.isCapabilityActive?.() === false) {
        invalidate("capability_revoked");
      }
    } catch (error) {
      if (error instanceof BridgeFault) throw error;
      invalidate("capability_revoked");
    }
    try { deadline.throwIfExpired(); } catch { invalidate("deadline_exceeded"); }
  }
  function authenticate(request: Record<string, unknown>): void {
    if (request.taskId !== capability.taskId || request.ownerEpoch !== capability.ownerEpoch
        || typeof request.token !== "string" || request.token.length > 512
        || !timingSafeEqual(tokenDigest, digest(request.token))) throw new BridgeFault("unauthorized");
    live();
  }
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    live();
    try {
      const result = await action();
      live();
      return result;
    } catch (error) {
      executorFailed = true;
      live();
      throw error;
    }
  }
  // Check ownership around EVERY awaited Executor operation. edit_file performs
  // a read followed by a write; revocation during the read must stop the write.
  const executor: Executor = {
    workspaceRoot: options.executor.workspaceRoot,
    readFile: (path, opts) => { workspacePath(path); return operation(() => options.executor.readFile(path, opts)); },
    writeFile: (path, content, opts) => { workspacePath(path); return operation(() => options.executor.writeFile(path, content, opts)); },
    listFiles: (pattern, opts) => { workspacePath(pattern, true); return operation(() => options.executor.listFiles(pattern, opts)); },
    grep: (pattern, glob, opts) => {
      if (glob !== undefined) workspacePath(glob, true);
      return operation(() => options.executor.grep(pattern, glob, opts));
    },
    run: (command, opts) => operation(async () => {
      if (opts?.cwd !== undefined) workspacePath(opts.cwd);
      const result = await options.executor.run(command, opts);
      live();
      if (result.timedOut && result.exitCode === 0) throw new BridgeFault("executor_result_invalid");
      return result;
    }),
  };
  let integrations: ReturnType<typeof bindScopedIntegrations>;
  try {
    integrations = bindScopedIntegrations(options.integrations, live,
      fn => operation(async () => { try { return await fn(); } catch { throw new Error('integration_operation_failed'); } }), deadline);
  } catch (error) { deadline.dispose(); throw error; }
  const safeNames = new Set<string>([...EXECUTOR_TOOL_NAMES, ...integrations.availableTools]);
  if (options.readOnly) for (const name of ['write_file', 'edit_file', 'commit', 'unassign_self', 'set_ticket_state', 'update_ticket_description']) safeNames.delete(name);
  if (options.allowedTools.some(name => !safeNames.has(name))) {
    deadline.dispose(); throw new Error('explicit supported tool allowlist requires scoped host bindings');
  }
  tools = makeToolset(executor, { ...integrations.toolset, deadlineMs: deadline.deadlineMs, signal: deadline.signal,
    finishGateCommand: options.finishGateCommand, runLog, ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }) });
  // Requested names must be present, never silently omitted on a binding mismatch.
  if (options.allowedTools.some(name => !Object.hasOwn(tools.handlers, name))) {
    deadline.dispose(); throw new Error('requested tool handler unavailable');
  }
  // No native Hermes integrations, network tools, or delegation are registered.
  for (const name of Object.keys(tools.handlers)) if (!allowed.has(name)) delete tools.handlers[name];
  tools.definitions = tools.definitions.filter(definition => allowed.has(definition.name));
  const definitions: OpenAIToolDefinition[] = tools.definitions.map(definition => {
    const parameters: Record<string, unknown> = { ...structuredClone(definition.input_schema), additionalProperties: false };
    // The pinned Hermes sanitizer omits empty required lists. Canonicalize the
    // equivalent zero-argument schema here so the worker can retain exact checks.
    if (Array.isArray(parameters.required) && parameters.required.length === 0) delete parameters.required;
    return { type: "function", function: { name: definition.name,
      description: definition.description ?? "", parameters } };
  });

  function snapshot(): BridgeState {
    return { finishSummary: tools.finishSummary, blockedReason: tools.blockedReason,
      finishGateMet: tools.finishGateMet, readCache: [...tools.readCache],
      todos: structuredClone(tools.todos), runLog: structuredClone(runLog), invalidated };
  }
  function response(id: string, name: string, content: string, error?: string, revealState = true): ToolInvocationResult {
    const result: ToolInvocationResult = {
      ok: error === undefined, tool_call_id: id, name, content: "", ...(error ? { error } : {}), truncated: false,
      state: { finishSummary: !revealState || tools.finishSummary === null ? null : boundedText(tools.finishSummary, 128),
        blockedReason: !revealState || tools.blockedReason === null ? null : boundedText(tools.blockedReason, 128),
        finishGateMet: revealState && tools.finishGateMet, runLogCount: revealState ? runLog.length : 0,
        invalidated: revealState && invalidated },
    };
    // Bound the entire UTF-8 JSON response, including escaping and metadata.
    let end = Math.min(content.length, limits.result);
    result.content = content.slice(0, end);
    result.truncated = result.content.length < content.length
      || (revealState && (result.state.finishSummary !== tools.finishSummary || result.state.blockedReason !== tools.blockedReason));
    while (Buffer.byteLength(JSON.stringify(result)) > limits.result && end > 0) {
      end = Math.floor(end * 0.8);
      result.content = content.slice(0, end);
      result.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(result)) > limits.result) {
      result.state.finishSummary = null;
      result.state.blockedReason = null;
      result.truncated = true;
    }
    return result;
  }
  return {
    get definitions() { return structuredClone(definitions); },
    get state() { return snapshot(); },
    async invoke(raw: unknown): Promise<ToolInvocationResult> {
      let id = "", name = "", acquired = false, authenticated = false;
      try {
        if (!isObject(raw)) throw new BridgeFault("invalid_request");
        // Copy the authentication envelope before awaiting; callers cannot mutate it.
        const request = { ...raw };
        authenticate(request);
        authenticated = true;
        if (typeof request.callId !== "string" || !ID.test(request.callId)
            || typeof request.name !== "string" || !ID.test(request.name)) throw new BridgeFault("invalid_request");
        id = request.callId; name = request.name;
        if (calls.has(id)) throw new BridgeFault("duplicate_call");
        if (calls.size >= limits.calls) throw new BridgeFault("call_limit");
        calls.add(id);
        if (busy) throw new BridgeFault("bridge_busy");
        if (tools.finishSummary !== null || tools.blockedReason !== null) throw new BridgeFault("task_terminal");
        const handler = Object.hasOwn(tools.handlers, name) ? tools.handlers[name] : undefined;
        if (!allowed.has(name) || !handler) throw new BridgeFault("tool_denied");
        let input: unknown;
        try {
          const serialized = typeof request.arguments === "string" ? request.arguments : JSON.stringify(request.arguments);
          if (typeof serialized !== "string" || Buffer.byteLength(serialized) > limits.input) throw new BridgeFault("input_too_large");
          input = JSON.parse(serialized);
        } catch (error) {
          if (error instanceof BridgeFault) throw error;
          throw new BridgeFault("invalid_arguments");
        }
        if (!isObject(input)) throw new BridgeFault("invalid_arguments");
        const keys = Object.keys(handler.definition.input_schema.properties ?? {});
        if (Object.keys(input).some(key => !keys.includes(key))) throw new BridgeFault("invalid_arguments");
        const required = handler.definition.input_schema.required;
        if (Array.isArray(required) && required.some(key => typeof key !== 'string' || !Object.hasOwn(input, key))) throw new BridgeFault('invalid_arguments');
        if (name === "read_file" || name === "write_file" || name === "edit_file") workspacePath(input.path);
        if (name === "list_files" || (name === "grep" && input.path_glob !== undefined)) workspacePath(input.path_glob, true);
        authenticate(request);
        busy = true; acquired = true; executorFailed = false;
        let output: string;
        try {
          if (name === "finish" && options.assertFinishEvidence) { await options.assertFinishEvidence(deadline.signal); authenticate(request); }
          output = await handler.run(input);
        }
        catch (error) { authenticate(request); throw error; }
        authenticate(request);
        // File contents and grep matches are arbitrary data, including text that
        // begins with "error". Only trusted operation failures and known control
        // tool outcomes determine the protocol's error bit.
        const failed = executorFailed || (name === "finish" && tools.finishSummary === null)
          || (name === "edit_file" && output.startsWith("error: "))
          || (name === "commit" && output.startsWith("commit failed (exit "))
          || (name === "todo_write" && output.startsWith("error in todo_write: "));
        const result = response(id, name, output, failed ? "tool_failed" : undefined);
        if (result.truncated && name === "read_file") tools.readCache.delete(input.path as string);
        return result;
      } catch (error) {
        const code = error instanceof BridgeFault ? error.code : "tool_failed";
        return response(id, name, code, code, authenticated);
      } finally {
        if (acquired) busy = false;
      }
    },
    dispose() { disposed = true; invalidated = true; cancellation.abort(); tools.finishSummary = null; tools.blockedReason = null;
      tools.finishGateMet = false; deadline.dispose(); },
  };
}
