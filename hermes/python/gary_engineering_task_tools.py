"""Host-bound seams for the pinned native delegation and code tools.

Native public functions and registry handlers remain intact. Child descriptors
are inert: only an admitted host task operation can execute a child or script.
This module contains no child agent, process, socket, or filesystem executor.
"""
from __future__ import annotations

import contextlib
import copy
import importlib
import json
import math
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

from gary_engineering_runtime import EngineeringFault, _ADMISSION


def _snapshot_native_processes():
    """Read only the already-isolated worker PID namespace, never the host.

    No entry is silently skipped: a process-table race is uncertainty. Native
    scripts may fork/setsid, so following only the original child PID or group
    cannot prove that all scoped-home writers are gone.
    """
    if sys.platform != "linux":
        raise EngineeringFault("native_code_process_namespace_required")
    entries = sorted(p for p in Path("/proc").iterdir() if p.name.isdecimal())
    if not entries or len(entries) > 512:
        raise EngineeringFault("native_code_process_table_limit")
    result = {}
    try:
        for entry in entries:
            raw = (entry / "stat").read_text()
            prefix, fields = raw.rsplit(") ", 1)
            if not prefix.startswith(entry.name + " ("):
                raise ValueError("process identity changed")
            started = fields.split()[19]  # Linux proc field22, starttime.
            if not started.isdecimal():
                raise ValueError("invalid process birth")
            result[int(entry.name)] = started
    except (OSError, ValueError, IndexError) as exc:
        raise EngineeringFault("native_code_process_table_uncertain") from exc
    if os.getpid() not in result:
        raise EngineeringFault("native_code_process_identity_missing")
    return result


class NativeCodeProcessBoundary:
    """Fail closed on leftover, reused or unobserved worker processes."""
    def __init__(self):
        self.before = _snapshot_native_processes()
        if _snapshot_native_processes() != self.before:
            raise EngineeringFault("native_code_process_table_unstable")

    def assert_current(self):
        if (_snapshot_native_processes() != self.before
                or _snapshot_native_processes() != self.before):
            raise EngineeringFault("native_code_process_cleanup_unconfirmed")


class NativeTaskTools:
    def __init__(self, *, scope_key, delegation_depth, confined_code=False):
        if not isinstance(scope_key, str) or not scope_key or len(scope_key) > 256:
            raise EngineeringFault("invalid_task_scope")
        if type(delegation_depth) is not int or delegation_depth not in (0, 1):
            raise EngineeringFault("invalid_delegation_depth")
        self.scope_key = scope_key
        self.delegation_depth = delegation_depth
        if type(confined_code) is not bool:
            raise EngineeringFault("invalid_code_isolation")
        self.confined_code = confined_code
        self._session = self._agent = self._stack = None
        self._children = {}
        self._operation_lock = threading.Lock()

    @staticmethod
    def _deny(*args, **kwargs):
        raise EngineeringFault("native_task_fallback_denied")

    def _admission(self, tool):
        admission = _ADMISSION.get()
        if (self._session is None or self._session.scope_key != self.scope_key
                or not isinstance(admission, dict)
                or admission.get("session") is not self._session
                or admission.get("active") is not True
                or admission.get("toolName") != tool
                or not isinstance(admission.get("args"), dict)):
            raise EngineeringFault("unbound_native_task_operation")
        self._session._guard()
        return admission

    def _parent(self, parent):
        if (self._agent is None or parent is not self._agent
                or getattr(parent, "session_id", None) != self._session.binding["sessionId"]
                or getattr(parent, "_delegate_depth", None) != self.delegation_depth):
            raise EngineeringFault("native_parent_identity_mismatch")

    def _tasks(self, args):
        """Reject unimplemented authority-bearing options before native setup."""
        allowed = {"goal", "context", "tasks", "role", "background", "action",
                   "subagent_id", "message", "max_iterations", "output_schema"}
        if set(args) - allowed or self.delegation_depth != 0:
            raise EngineeringFault("native_delegation_option_denied")
        if (args.get("background") is not None and args.get("background") is not False
                or args.get("action") not in (None, "", "spawn")
                or args.get("role") not in (None, "leaf")
                or any(args.get(key) is not None for key in ("subagent_id", "message", "output_schema"))):
            raise EngineeringFault("native_delegation_option_denied")
        iterations = args.get("max_iterations")
        if iterations is not None and (type(iterations) is not int or iterations <= 0):
            raise EngineeringFault("invalid_native_delegation_iterations")
        tasks = args.get("tasks")
        if tasks is None or tasks == []:
            tasks = [{"goal": args.get("goal"), "context": args.get("context")}]
        if not isinstance(tasks, list) or not 1 <= len(tasks) <= 2:
            raise EngineeringFault("invalid_native_delegation_tasks")
        normalized = []
        for task in tasks:
            if (not isinstance(task, dict) or set(task) - {"goal", "context", "role"}
                    or task.get("role") not in (None, "leaf")):
                raise EngineeringFault("native_delegation_option_denied")
            goal, context = task.get("goal"), task.get("context")
            if (not isinstance(goal, str) or not goal.strip()
                    or context is not None and not isinstance(context, str)):
                raise EngineeringFault("invalid_native_delegation_task")
            normalized.append({"goal": goal, "context": context})
        return normalized

    def _background(self, args, parent_agent=None):
        admission = self._admission("delegate_task")
        self._parent(parent_agent)
        if args != admission["args"]:
            raise EngineeringFault("native_delegation_arguments_changed")
        self._tasks(args)
        return False

    def _credentials(self, cfg, parent_agent):
        self._parent(parent_agent)
        self._tasks(self._admission("delegate_task")["args"])
        # No provider lookup, credential inheritance, ACP, or fallback client.
        return dict.fromkeys(("model", "provider", "base_url", "api_key", "api_mode"))

    def _build_child(self, **kwargs):
        admission = self._admission("delegate_task")
        self._parent(kwargs.get("parent_agent"))
        tasks = self._tasks(admission["args"])
        index = kwargs.get("task_index")
        if (type(index) is not int or not 0 <= index < len(tasks)
                or type(kwargs.get("task_count")) is not int or kwargs["task_count"] != len(tasks)
                or kwargs.get("goal") != tasks[index]["goal"]
                or kwargs.get("context") != tasks[index]["context"]
                or kwargs.get("role") != "leaf"
                or any(kwargs.get(key) is not None for key in (
                    "toolsets", "model", "override_provider", "override_base_url",
                    "override_api_key", "override_api_mode", "override_request_overrides",
                    "override_max_tokens", "override_acp_command", "override_acp_args"))):
            raise EngineeringFault("native_child_arguments_changed")
        key = (id(admission), index)
        with self._operation_lock:
            if key in self._children:
                raise EngineeringFault("native_child_replayed")
            child = SimpleNamespace(_delegate_role="leaf", _delegate_depth=1)
            self._children[key] = {"child": child, "admission": admission,
                                   "task": copy.deepcopy(tasks[index]), "used": False}
        return child

    @staticmethod
    def _result(value):
        if not isinstance(value, dict):
            raise EngineeringFault("invalid_native_task_result")
        # Copy only JSON data; reject NaN, objects, and unbounded host output.
        wire = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(wire.encode("utf-8")) > 262144:
            raise EngineeringFault("native_task_result_limit")
        return json.loads(wire)

    def _run_child(self, task_index, goal, child=None, parent_agent=None, *,
                   owner_session_id=None, owner_transport=None, owner_session_record=None, **_kwargs):
        admission = self._admission("delegate_task")
        self._parent(parent_agent)
        if type(task_index) is not int:
            raise EngineeringFault("invalid_native_child_index")
        # Native batches use copied contexts and two threads, but each host
        # exchange and physical child run remains serial. Consume before RPC;
        # an uncertain operation is never retried through this descriptor.
        with self._operation_lock:
            record = self._children.get((id(admission), task_index))
            if (record is None or record["admission"] is not admission
                    or record["child"] is not child or record["used"]
                    or goal != record["task"]["goal"]):
                raise EngineeringFault("unbound_or_replayed_native_child")
            self._admission("delegate_task")
            record["used"] = True
            result = self._result(self._session.task_rpc("delegate.run", {
                "taskIndex": task_index, "goal": goal, "context": record["task"]["context"]}))
        if (not {"task_index", "status", "summary", "api_calls", "duration_seconds"} <= result.keys()
                or type(result.get("task_index")) is not int or result["task_index"] != task_index
                or result.get("status") not in ("completed", "failed", "error", "interrupted")
                or result.get("summary") is not None and not isinstance(result["summary"], str)
                or type(result.get("api_calls")) is not int or result["api_calls"] < 0
                or type(result.get("duration_seconds")) not in (int, float)
                or not math.isfinite(result["duration_seconds"]) or result["duration_seconds"] < 0):
            raise EngineeringFault("invalid_native_child_result")
        return result

    def _execute_remote(self, code, task_id, enabled_tools):
        if self.confined_code:
            raise EngineeringFault("native_code_remote_fallback_denied")
        admission = self._admission("execute_code")
        if (task_id != self._session.binding["taskId"] or not isinstance(code, str)
                or not code.strip() or code != admission["args"].get("code")
                or set(admission["args"]) != {"code"}):
            raise EngineeringFault("native_code_arguments_changed")
        self._code_config()
        with self._operation_lock:
            self._admission("execute_code")
            if admission.get("garyCodeOperationConsumed"):
                raise EngineeringFault("native_code_replayed")
            admission["garyCodeOperationConsumed"] = True
            result = self._result(self._session.task_rpc("code.run", {"code": code}))
        return json.dumps(result, ensure_ascii=False, allow_nan=False)

    def configure_agent(self, agent):
        if (self._stack is None or self._agent is not None
                or getattr(agent, "session_id", None) != self._session.binding["sessionId"]):
            raise EngineeringFault("unbound_native_task_agent")
        self._agent = agent
        self._stack.enter_context(patch.object(agent, "_delegate_depth", self.delegation_depth, create=True))

        def dispatch(args):
            self._background(args, agent)
            # Preserve the native public function and its validation/aggregation.
            return self._delegate.delegate_task(
                goal=args.get("goal"), context=args.get("context"), tasks=args.get("tasks"),
                max_iterations=args.get("max_iterations"), role=args.get("role"),
                background=False, output_schema=args.get("output_schema"),
                action=args.get("action"), subagent_id=args.get("subagent_id"),
                message=args.get("message"), parent_agent=agent)

        self._stack.enter_context(patch.object(agent, "_dispatch_delegate_task", dispatch, create=True))

    @contextlib.contextmanager
    def install(self, session):
        if (self._session is not None or session.scope_key != self.scope_key
                or not callable(getattr(session, "task_rpc", None))):
            raise EngineeringFault("invalid_native_task_session")
        with contextlib.ExitStack() as stack:
            self._session, self._stack = session, stack
            try:
                delegate = self._delegate = importlib.import_module("tools.delegate_tool")
                code = importlib.import_module("tools.code_execution_tool")
                terminal = importlib.import_module("tools.terminal_tool")
                approval = importlib.import_module("tools.approval")
                live = importlib.import_module("tools.delegation_live_log")
                asynchronous = importlib.import_module("tools.async_delegation")
                original_config = terminal._get_env_config
                original_guard = approval.check_execute_code_guard

                def code_config():
                    config = original_config()
                    if not isinstance(config, dict) or config.get("env_type") != "gary":
                        raise EngineeringFault("native_code_backend_denied")
                    return config

                self._code_config = code_config

                def env_config():
                    admission = _ADMISSION.get()
                    if isinstance(admission, dict) and admission.get("toolName") == "execute_code":
                        self._admission("execute_code")
                        selected = code_config()
                        # The native Python orchestrator runs inside the
                        # launcher's network-none, nonroot worker container.
                        # Its inherited tool calls still target GaryEnvironment
                        # in the separate project sandbox. Never enable this
                        # path for a host stdio/embedded fixture.
                        return dict(selected, env_type="local") if self.confined_code else selected
                    return original_config()

                def code_guard(source, env_type, has_host_access=False):
                    admission = self._admission("execute_code")
                    if (env_type != ("local" if self.confined_code else "gary") or has_host_access is not False
                            or source != admission["args"].get("code")
                            or set(admission["args"]) != {"code"}):
                        raise EngineeringFault("native_code_guard_denied")
                    code_config()
                    # Existing native guard denials stay denials. No yolo or
                    # approval-mode override is added by the host adapter.
                    result = original_guard(source, "gary", has_host_access=False)
                    if self.confined_code and result.get("approved") is True:
                        allowed = self._session.begin_code(source, cleanup_guard=NativeCodeProcessBoundary().assert_current)
                        # Native stub generation occurs after this guard. Bind
                        # its exact set to host authorization; [] must remain
                        # empty even through the native empty-intersection path.
                        code.SANDBOX_ALLOWED_TOOLS = frozenset(allowed)
                    return result

                replacements = (
                    (delegate, "_build_child_preserving_parent_tools", self._build_child),
                    (delegate, "_build_child_agent", self._deny),
                    (delegate, "_run_single_child", self._run_child),
                    (delegate, "_resolve_delegation_credentials", self._credentials),
                    (delegate, "_model_background_value", self._background),
                    (delegate, "_handle_control_action", self._deny),
                    (delegate, "_get_max_concurrent_children", lambda: 2),
                    (delegate, "_get_max_spawn_depth", lambda: 1),
                    (delegate, "_get_orchestrator_enabled", lambda: False),
                    (delegate, "_get_worktree_isolation", lambda: False),
                    (delegate, "_capture_gateway_steer_authority", lambda *_: (None, None)),
                    # Host receipts own accounting and results. Avoid native
                    # filesystem spills, memory providers, and plugin hooks.
                    (delegate, "_finalize_child_results", lambda *args, **kwargs: None),
                    (live, "create_live_transcripts", lambda *args, **kwargs: (None, [], [])),
                    (live, "update_manifest_statuses", lambda *args, **kwargs: None),
                    (asynchronous, "dispatch_async_delegation_batch", self._deny),
                    (terminal, "register_container_alias", self._deny),
                    (terminal, "_get_env_config", env_config),
                    (approval, "check_execute_code_guard", code_guard),
                    (code, "_execute_remote", self._execute_remote),
                )
                for obj, name, replacement in replacements:
                    stack.enter_context(patch.object(obj, name, replacement))
                if self.confined_code:
                    # Preserve native subprocess/RPC orchestration algorithms,
                    # using their strict temporary cwd and bounded output/calls.
                    stack.enter_context(patch.object(code, "SANDBOX_ALLOWED_TOOLS",
                        frozenset({"terminal", "read_file", "write_file", "patch", "search_files"})))
                    stack.enter_context(patch.object(code, "_get_execution_mode", lambda: "strict"))
                    stack.enter_context(patch.object(code, "_load_config", lambda: {
                        "mode": "strict", "timeout": 300, "max_tool_calls": 50}))
                yield
            finally:
                # ExitStack restores configured agents before module hooks.
                stack.close()
                self._children.clear()
                self._session = self._agent = self._stack = None
