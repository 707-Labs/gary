"""Opt-in engineering session protocol; production gary_runtime is unchanged.

The RPC and model-client factory are injected by a trusted launcher. This file
contains no network transport, provider credentials, Docker or host shell path.
Native handlers remain native registry entries; authorization surrounds them.
"""
from __future__ import annotations

import contextlib
import contextvars
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid
from unittest.mock import patch

PROTOCOL = "gary.engineering.v1"
PINNED_REVISION = "9664e386f67965ec8bec5cf3db9d411f2c2b6cc0"
# Core tools are always bound. State/process tools require explicit host scope
# grants; delegation and execute_code also require reviewed adapter hooks.
NATIVE_TOOLS = frozenset({"terminal", "read_file", "write_file", "patch", "search_files"})
NATIVE_MODULES = {**{name: "tools.file_tools" for name in NATIVE_TOOLS - {"terminal"}},
    "terminal": "tools.terminal_tool", "process": "tools.process_registry",
    "todo": "tools.todo_tool", "memory": "tools.memory_tool",
    "session_search": "tools.session_search_tool", "skills_list": "tools.skills_tool",
    "skill_view": "tools.skills_tool", "skill_manage": "tools.skill_manager_tool",
    "delegate_task": "tools.delegate_tool", "execute_code": "tools.code_execution_tool"}
_ADMISSION = contextvars.ContextVar("gary_engineering_admission", default=None)


class EngineeringFault(RuntimeError):
    pass


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _native_messages(value):
    """Normalize wire fields, also usable on an incomplete native batch."""
    from gary_runtime import _message
    if not isinstance(value, list):
        raise EngineeringFault("invalid_native_history")
    messages = copy.deepcopy(value)
    for message in messages:
        if isinstance(message, dict):
            for call in message.get("tool_calls", []):
                if not isinstance(call, dict):
                    raise EngineeringFault("invalid_native_tool_call")
                if call.get("call_id", call.get("id")) != call.get("id"):
                    raise EngineeringFault("native_call_identity_changed")
                call.pop("call_id", None)
                call.pop("response_item_id", None)
    # Match _history(native=True): native system rows are bookkeeping; the
    # host separately pins the one system prompt actually sent to its model.
    return [_message(message, native=True) for message in messages
            if not (isinstance(message, dict) and message.get("role") == "system")]


def native_history(value):
    """Drop pinned Hermes bookkeeping and validate a complete wire history."""
    from gary_runtime import _history
    return _history(_native_messages(value), native=True)


# Diagnostics contain fixed codes and source locations only: no messages,
# arguments, paths, source text, locals, or arbitrary exception class names.
SAFE_FAULT_CODES = frozenset(['child_delegation_denied', 'cleanup_unconfirmed', 'close_during_native_tool', 'code_cleanup_unconfirmed', 'code_process_cleanup_unconfirmed', 'code_requires_isolated_native_worker', 'concurrent_environment_execution', 'cross_profile_denied', 'cross_profile_session_lookup_denied', 'environment_closed', 'environment_closing', 'polling_cleanup_unconfirmed', 'environment_fenced', 'environment_operation_limit', 'environment_operation_rejected', 'expired_tool_admission', 'foreign_native_module', 'frame_limit', 'host_rejected', 'host_reply_limit', 'host_system_prompt_changed', 'incomplete_process_output', 'inherited_call_limit', 'inherited_process_mode_denied', 'invalid_code_authorization', 'invalid_command', 'invalid_command_timeout', 'invalid_deadline', 'invalid_delegation_depth', 'invalid_engineering_binding', 'invalid_engineering_start', 'invalid_host_system_prompt', 'invalid_model_limits', 'invalid_native_context', 'invalid_native_context_tools', 'invalid_native_history', 'invalid_native_source', 'invalid_native_tool_call', 'invalid_process_start', 'invalid_process_status', 'invalid_result_presentation', 'invalid_scoped_directory', 'invalid_scoped_home', 'invalid_scoped_session_path', 'invalid_stdin', 'invalid_task_operation', 'invalid_task_result', 'invalid_turn_frame', 'local_process_denied', 'missing_guarded_model_client_or_profile', 'missing_process_exit_code', 'missing_scoped_directory', 'missing_scoped_session_db', 'model_request_limit', 'model_response_shape', 'model_route_denied', 'native_agent_session_mismatch', 'native_batch_history_changed', 'native_batch_overlap', 'native_batch_result_mismatch', 'native_call_identity_changed', 'native_call_identity_replayed', 'native_dotenv_present', 'native_environment_collision', 'native_file_cwd_unbound', 'native_handler_changed', 'native_identity_mismatch', 'native_pin_mismatch', 'native_presentation_limit', 'native_process_action_not_implemented', 'native_process_feature_not_implemented', 'native_profile_changed', 'native_profile_not_installed', 'native_registry_mismatch', 'native_result_count_invalid', 'native_result_history_missing', 'native_result_limit', 'native_scope_mismatch', 'parallel_native_tool_denied', 'process_deadline_exceeded', 'process_identity_mismatch', 'process_observation_failed', 'process_output_limit', 'scoped_config_symlink', 'scoped_directory_contains_symlink', 'scoped_home_symlink', 'scoped_memory_identity_changed', 'scoped_session_checkpoint_busy', 'scoped_session_checkpoint_incomplete', 'scoped_session_identity_changed', 'session_closed', 'session_deadline', 'session_fenced', 'skill_roots_overlap', 'stdio_frame_limit', 'stdio_reply_mismatch', 'stdio_transport_fenced', 'tool_arguments_changed', 'tool_arguments_limit', 'tool_limit', 'tool_not_allowed_or_replayed', 'turn_replay_or_limit', 'unapproved_native_tool', 'unbound_background_start', 'unbound_code_invocation', 'unbound_environment_operation', 'unbound_inherited_call', 'unbound_native_environment', 'unbound_task_operation', 'unknown_environment_operation', 'unknown_native_capability'])
SAFE_FAULT_FILES = frozenset({"gary_engineering_runtime.py", "gary_engineering_environment.py", "gary_runtime.py", "tool_executor.py", "terminal_tool.py", "conversation_loop.py"})

def worker_fault(error):
    chain, seen = [], set()
    while error is not None and id(error) not in seen and len(chain) < 4:
        seen.add(id(error))
        code = error.args[0] if type(error) in (EngineeringFault,) and len(error.args) == 1 else "unknown_failure"
        if type(error).__name__ == "EnvironmentFault" and type(error).__module__ == "gary_engineering_environment" and len(error.args) == 1:
            code = error.args[0]
        if not isinstance(code, str) or code not in SAFE_FAULT_CODES:
            code = "unknown_failure"
        frames, trace = [], error.__traceback__
        while trace:
            name = Path(trace.tb_frame.f_code.co_filename).name
            if name in SAFE_FAULT_FILES:
                frames.append({"file": name, "line": trace.tb_lineno})
            trace = trace.tb_next
        chain.append({"code": code, "frames": frames[-4:]})
        error = error.__cause__ or error.__context__
    return {"version": 1, "causes": chain}


def _id(value, name):
    if not isinstance(value, str) or not value or len(value) > 256:
        raise EngineeringFault("invalid_" + name)
    return value


@contextlib.contextmanager
def scoped_home(root, *, restore=False):
    """Bootstrap a host-selected empty home before importing any native code.

    One native worker process owns one scope. Production must exit after this
    context; restoring the operator environment is an explicit fixture option.
    The launcher owns persistent snapshot capture/restore and validates scope.
    """
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root:
        raise EngineeringFault("invalid_scoped_home")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    previous, previous_cwd = dict(os.environ), os.getcwd()
    previous_umask = os.umask(0o077)
    for name in ("home", "hermes", "plugins", "config", "cache", "data", "tmp", "work"):
        path = root / name
        if path.is_symlink():
            raise EngineeringFault("scoped_home_symlink")
        path.mkdir(mode=0o700, exist_ok=True)
    config_path = root / "hermes" / "config.yaml"
    if config_path.is_symlink():
        raise EngineeringFault("scoped_config_symlink")
    config_path.write_text(json.dumps({
        "plugins": {"enabled": [], "entries": {}}, "mcp_servers": {},
        "tools": {"tool_search": {"enabled": "off"}}, "fallback_providers": [],
        "terminal": {"backend": "gary", "cwd": "/workspace", "timeout": 120},
        "compression": {"enabled": False, "micro_compact": False, "proactive_prune_tokens": 0},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "skills": {"creation_nudge_interval": 0},
        "agent": {"environment_probe": False, "api_max_retries": 1,
                  "bot_mode_protocol": False, "tool_use_enforcement": False},
        "auxiliary": {"title_generation": {"enabled": False}, "background_review": {"enabled": False}},
        "curator": {"enabled": False}, "sessions": {"write_json_snapshots": False},
        "telemetry": {"shared_metrics": {"enabled": False}},
    }), encoding="utf-8")
    config_path.chmod(0o600)
    clean = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
             "HOME": str(root / "home"), "HERMES_HOME": str(root / "hermes"),
             "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
             "XDG_DATA_HOME": str(root / "data"), "TMPDIR": str(root / "tmp"),
             "HERMES_BUNDLED_PLUGINS": str(root / "plugins"),
             "HERMES_ENABLE_PROJECT_PLUGINS": "0", "PYTHONNOUSERSITE": "1",
             "PYTHONDONTWRITEBYTECODE": "1", "TERMINAL_ENV": "gary", "TERMINAL_CWD": "/workspace"}
    os.environ.clear()
    os.environ.update(clean)
    os.chdir(root / "work")
    try:
        yield
    finally:
        os.chdir(previous_cwd)
        os.umask(previous_umask)
        os.environ.clear()
        if restore:
            os.environ.update(previous)


def load_native_source(source):
    """Select the vendored source only; installed image digest is host-verified."""
    source = Path(source)
    if not source.is_absolute() or source.is_symlink() or not (source / "run_agent.py").is_file():
        raise EngineeringFault("invalid_native_source")
    provenance = source.parent.parent / "SOURCE.json"
    if json.loads(provenance.read_text()).get("hermes_revision") != PINNED_REVISION:
        raise EngineeringFault("native_pin_mismatch")
    if any((source / name).exists() for name in (".env", ".op.env")):
        raise EngineeringFault("native_dotenv_present")
    for module in ("hermes_constants", "tools.registry", "tools.environments.base"):
        existing = sys.modules.get(module)
        filename = getattr(existing, "__file__", None)
        if existing is not None and (not filename or not Path(filename).resolve().is_relative_to(source.resolve())):
            raise EngineeringFault("foreign_native_module")
    sys.path.insert(0, str(source))
    # Same pinned bootstrap seams as the existing worker; no dotenv, managed
    # overlays, provider entrypoint discovery or plugin filesystem scanning.
    import hermes_cli.env_loader as env_loader
    import hermes_cli.managed_scope as managed_scope
    env_loader.load_hermes_dotenv = lambda **kwargs: []
    managed_scope.get_managed_dir = lambda: None
    return source


class ScopedNativeContext:
    """Explicit host grants for native state tools and advanced adapter hooks.

    Paths are launcher-selected scoped mounts/snapshots, never model arguments.
    The host remains responsible for snapshot scope/provenance and skill
    promotion. Native skills manage drafts; list/view see approved versions.
    Delegation/code orchestration need reviewed adapters that own their child
    environment, admission and model accounting; absence fails closed.
    """

    def __init__(self, *, scope_key, tools, approved_skills=None, draft_skills=None,
                 memory_dir=None, session_db=None, advanced_adapters=None, owns_session_db=False):
        self.scope_key = _id(scope_key, "scope_key")
        self.tools = frozenset(tools)
        if not self.tools <= NATIVE_MODULES.keys() - NATIVE_TOOLS:
            raise EngineeringFault("unknown_native_capability")
        self.approved_skills, self.draft_skills = approved_skills, draft_skills
        self.memory_dir, self.session_db = memory_dir, session_db
        self.advanced_adapters = advanced_adapters or {}
        self.owns_session_db = owns_session_db
        self._database_closed = False
        self._database_checkpointed = False
        self.dispatch_kwargs = {}
        self.todo_store = self.memory_store = None

    @staticmethod
    def _directory(value):
        if value is None:
            raise EngineeringFault("missing_scoped_directory")
        path = Path(value)
        if not path.is_absolute() or path.is_symlink() or path.resolve() != path or not path.is_dir():
            raise EngineeringFault("invalid_scoped_directory")
        if any(child.is_symlink() for child in path.rglob("*")):
            raise EngineeringFault("scoped_directory_contains_symlink")
        return path

    @contextlib.contextmanager
    def install(self, session):
        if session.scope_key != self.scope_key:
            raise EngineeringFault("native_scope_mismatch")
        with contextlib.ExitStack() as stack:
            if "todo" in self.tools:
                from tools.todo_tool import TodoStore
                self.todo_store = TodoStore()
                self.dispatch_kwargs["todo"] = {"store": self.todo_store}
            if "memory" in self.tools:
                memory = importlib.import_module("tools.memory_tool")
                directory = self._directory(self.memory_dir)
                stack.enter_context(patch.object(memory, "get_memory_dir", lambda: directory))
                self.memory_store = memory.MemoryStore()
                self.memory_store.load_from_disk()
                self.dispatch_kwargs["memory"] = {"store": self.memory_store}
            if "session_search" in self.tools:
                if self.session_db is None:
                    raise EngineeringFault("missing_scoped_session_db")
                search = importlib.import_module("tools.session_search_tool")
                def deny_profile(*args, **kwargs):
                    raise EngineeringFault("cross_profile_session_lookup_denied")
                stack.enter_context(patch.object(search, "_resolve_profile_db", deny_profile))
                stack.enter_context(patch.object(search, "_locate_session_db", deny_profile))
                self.dispatch_kwargs["session_search"] = {"db": self.session_db,
                    "current_session_id": session.binding["sessionId"]}
            if self.tools & {"skills_list", "skill_view", "skill_manage"}:
                approved = self._directory(self.approved_skills)
                drafts = self._directory(self.draft_skills)
                if approved == drafts or approved.is_relative_to(drafts) or drafts.is_relative_to(approved):
                    raise EngineeringFault("skill_roots_overlap")
                skills = importlib.import_module("tools.skills_tool")
                manager = importlib.import_module("tools.skill_manager_tool")
                utils = importlib.import_module("agent.skill_utils")
                preprocessing = importlib.import_module("agent.skill_preprocessing")
                passthrough = importlib.import_module("tools.env_passthrough")
                credentials = importlib.import_module("tools.credential_files")
                def roots():
                    current = _ADMISSION.get()
                    return [drafts] if current and current.get("toolName") == "skill_manage" else [approved]
                for obj, name, value in (
                    (skills, "_skills_dir", lambda: approved), (manager, "_skills_dir", lambda: drafts),
                    (utils, "get_external_skills_dirs", lambda: []),
                    (utils, "get_project_skills_dirs", lambda: []),
                    (utils, "get_all_skills_dirs", roots),
                    (utils, "get_scan_ordered_skills_dirs", roots),
                    (manager, "_find_skill_in_other_profiles", lambda name: []),
                    (manager, "_maybe_debounced_sync_push", lambda name: None),
                    (manager, "_maybe_auto_propose_org_edit", lambda *args: None),
                    (skills, "load_env", lambda: {}), (skills, "_secret_capture_callback", None),
                    (passthrough, "register_env_passthrough", lambda names: None),
                    (credentials, "register_credential_files", lambda paths: list(paths)),
                    (preprocessing, "preprocess_skill_content", lambda content, *args, **kwargs: content),
                ):
                    stack.enter_context(patch.object(obj, name, value))
                skills._SKILLS_CACHE.clear()
                stack.callback(skills._SKILLS_CACHE.clear)
                stack.callback(skills.reset_skill_view_dedup, session.binding["taskId"])
            installed = set()
            for tool in self.tools & {"delegate_task", "execute_code"}:
                adapter = self.advanced_adapters.get(tool)
                if adapter is None or getattr(adapter, "scope_key", None) != self.scope_key:
                    raise EngineeringFault("missing_scoped_" + tool + "_adapter")
                # Adapter installs a native dispatch seam, never a replacement
                # registry handler. It must account for every child/model call.
                if id(adapter) not in installed:
                    stack.enter_context(adapter.install(session))
                    installed.add(id(adapter))
            yield

    def configure_agent(self, agent):
        if self.todo_store is not None:
            agent._todo_store = self.todo_store
        if self.memory_store is not None:
            agent._memory_store = self.memory_store
            agent._memory_manager = None  # no external provider synchronization
        if "session_search" in self.tools:
            agent._get_session_db_for_recall = lambda: self.session_db
        if self.session_db is not None:
            agent._session_db = self.session_db
            agent._owns_session_db = False
            agent._persist_disabled = False
        for adapter in {id(v): v for v in self.advanced_adapters.values()}.values():
            adapter.configure_agent(agent)

    def close(self):
        """Close the exact materialized database before the host snapshots it."""
        if self.owns_session_db and not self._database_closed:
            self.session_db.close()
            self._database_closed = True
        if self.owns_session_db and not self._database_checkpointed:
            # Native close releases its readers/writer. Explicitly checkpoint
            # the selected DB only; do not copy or discard a surviving WAL.
            import sqlite3
            path = Path(self.session_db.db_path)
            if path.is_symlink() or path.resolve() != path:
                raise EngineeringFault("scoped_session_identity_changed")
            path.chmod(0o600)
            db = sqlite3.connect(str(path), timeout=1)
            try:
                row = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if row is None or row[0] != 0:
                    raise EngineeringFault("scoped_session_checkpoint_busy")
            finally:
                db.close()
            if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm")):
                raise EngineeringFault("scoped_session_checkpoint_incomplete")
            if self.memory_dir:
                for name in ("MEMORY.md", "USER.md"):
                    memory = Path(self.memory_dir) / name
                    if memory.is_symlink():
                        raise EngineeringFault("scoped_memory_identity_changed")
                    if memory.exists():
                        memory.chmod(0o600)
            self._database_checkpointed = True


def native_context_from_start(value, home):
    """Only the launcher selects these paths, never native/model arguments."""
    if not isinstance(value, dict) or set(value) != {"version", "scopeKey", "tools", "delegationDepth", "confinedCode"} or value["version"] != 1 or type(value["confinedCode"]) is not bool:
        raise EngineeringFault("invalid_native_context")
    tools = value["tools"]
    if not isinstance(tools, list) or any(not isinstance(t, str) for t in tools) or len(set(tools)) != len(tools) or not set(tools) <= NATIVE_MODULES.keys() - NATIVE_TOOLS:
        raise EngineeringFault("invalid_native_context_tools")
    if type(value["delegationDepth"]) is not int or value["delegationDepth"] not in (0, 1):
        raise EngineeringFault("invalid_delegation_depth")
    if value["delegationDepth"] and "delegate_task" in tools:
        raise EngineeringFault("child_delegation_denied")
    if "execute_code" in tools and not value["confinedCode"]:
        raise EngineeringFault("code_requires_isolated_native_worker")
    root = ScopedNativeContext._directory(home)
    memory = ScopedNativeContext._directory(root / "hermes" / "memory")
    db_path = root / "hermes" / "session.sqlite"
    if db_path.is_symlink() or db_path.resolve() != db_path:
        raise EngineeringFault("invalid_scoped_session_path")
    from hermes_state import SessionDB
    adapters = {}
    if set(tools) & {"delegate_task", "execute_code"}:
        from gary_engineering_task_tools import NativeTaskTools
        adapter = NativeTaskTools(scope_key=value["scopeKey"], delegation_depth=value["delegationDepth"], confined_code=value["confinedCode"])
        adapters = {name: adapter for name in set(tools) & {"delegate_task", "execute_code"}}
    db = SessionDB(db_path=db_path)
    try:
        return ScopedNativeContext(scope_key=value["scopeKey"], tools=tools,
            approved_skills="/task/skills-approved", draft_skills="/task/skill-drafts",
            memory_dir=memory, session_db=db, advanced_adapters=adapters, owns_session_db=True)
    except BaseException:
        db.close()
        raise


class EngineeringSession:
    def __init__(self, binding, rpc, *, max_turns=64, max_tool_calls=100,
                 max_frames=20000, max_result_bytes=1_048_576, result_presentation="raw"):
        if result_presentation not in ("raw", "native_batch"):
            raise EngineeringFault("invalid_result_presentation")
        self.result_presentation = result_presentation
        self._native_batch = None
        self.binding = {name: _id(binding.get(name), name)
                        for name in ("taskId", "sessionId", "ownerEpoch")}
        self.scope_key = binding.get("scopeKey")
        deadline = binding.get("deadlineMs")
        if isinstance(deadline, bool) or not isinstance(deadline, int) or deadline <= 0:
            raise EngineeringFault("invalid_deadline")
        self.deadline_ms = deadline
        self.rpc = rpc
        self.max_turns, self.max_tool_calls = max_turns, max_tool_calls
        self.max_frames, self.max_result_bytes = max_frames, max_result_bytes
        self.turn_id = None
        self._turns, self._calls = set(), set()
        self._sequence = 0
        self._rpc_lock = threading.Lock()
        self._tool_lock = threading.Lock()
        self._code_tool_lock = threading.Lock()
        self._code_invocation = None
        self._fenced = False
        self._closed = False
        self.environment = None
        self.registry = None
        self.native_entries = {}
        self.events = []
        self.native_context = None
        self._turn_iteration_limit = False
        self._turn_tool_counts = dict(toolCalls=0, toolFailures=0, toolBlocks=0, toolResultErrors=0)
        self._turn_tool_error_details = []
        self._first_fault = None
        self._fault_lock = threading.Lock()

    def _record_backend_fault(self, error):
        # Backend cancellation/observation failure drains the owned session.
        # Native error conversion must not permit another model turn on it.
        with self._fault_lock:
            self._first_fault = self._first_fault or worker_fault(error)
            self._fenced = True

    def failure_diagnostic(self, error):
        with self._fault_lock:
            diagnostic = copy.deepcopy(self._first_fault) if self._first_fault else worker_fault(error)
        environment = self.environment
        if environment is not None:
            with environment._operation_lock:
                if environment._first_transition:
                    diagnostic["lifecycle"] = copy.deepcopy(environment._first_transition)
        return diagnostic

    def _guard(self):
        if self._closed or self._fenced:
            raise EngineeringFault("session_fenced")
        if int(time.time() * 1000) >= self.deadline_ms:
            self._fenced = True
            raise EngineeringFault("session_deadline")

    def _send(self, kind, payload, *, cleanup=False):
        with self._rpc_lock:
            if not cleanup:
                self._guard()
            if self._closed:
                raise EngineeringFault("session_closed")
            self._sequence += 1
            if self._sequence > self.max_frames and not cleanup:
                self._fenced = True
                raise EngineeringFault("frame_limit")
            frame = dict(self.binding, protocol=PROTOCOL, turnId=self.turn_id or "",
                         sequence=self._sequence, kind=kind, payload=copy.deepcopy(payload))
            try:
                reply = self.rpc(frame)
                if not isinstance(reply, dict) or reply.get("ok") is not True:
                    raise EngineeringFault("host_rejected")
                _id(reply.get("receiptId"), "host_receipt")
                if len(canonical_json(reply).encode()) > self.max_result_bytes:
                    raise EngineeringFault("host_reply_limit")
                return reply
            except BaseException as error:
                self._record_backend_fault(error)
                raise

    def begin_turn(self, turn_id):
        self._guard()
        _id(turn_id, "turn_id")
        if self._tool_lock.locked() or turn_id in self._turns or len(self._turns) >= self.max_turns:
            raise EngineeringFault("turn_replay_or_limit")
        self._turns.add(turn_id)
        self.turn_id = turn_id

    def environment_rpc(self, operation, arguments):
        if operation == "close":
            reply = self._send("session.close", {}, cleanup=True)
            if reply.get("cleanupConfirmed") is not True:
                self._fenced = True
                raise EngineeringFault("cleanup_unconfirmed")
            self._closed = True
            return reply
        admission = _ADMISSION.get()
        if admission is None or admission["session"] is not self:
            raise EngineeringFault("unbound_environment_operation")
        # Late operations cannot escape a completed native call, even if a
        # helper retained a copied context or a process handle.
        if not admission["active"]:
            raise EngineeringFault("expired_tool_admission")
        if operation not in ("execute", "poll", "cancel"):
            raise EngineeringFault("unknown_environment_operation")
        reply = self._send("environment.operation", {
            "toolCallId": admission["toolCallId"], "admissionId": admission["admissionId"],
            "operation": operation, "arguments": arguments,
        }, cleanup=operation == "cancel")
        admission["receipts"].append(reply["receiptId"])
        if admission.get("codeInvocationId"):
            self._code_invocation["receipts"].append(reply["receiptId"])
        return reply

    def begin_code(self, source, cleanup_guard=None):
        parent = _ADMISSION.get()
        if (not parent or parent["session"] is not self or not parent["active"]
                or parent["toolName"] != "execute_code" or parent["args"] != {"code": source}
                or self._code_invocation is not None or parent.get("codeConsumed")):
            raise EngineeringFault("unbound_code_invocation")
        parent["codeConsumed"] = True
        ids = {"toolCallId": parent["toolCallId"], "admissionId": parent["admissionId"]}
        authorized = self._send("code.authorize", dict(ids, codeHash=digest(source)))
        tools = authorized.get("allowedTools")
        if (authorized.get("deadlineMs") != self.deadline_ms or not isinstance(tools, list)
                or not set(tools) <= NATIVE_TOOLS or len(set(tools)) != len(tools)):
            raise EngineeringFault("invalid_code_authorization")
        parent["receipts"].append(authorized["receiptId"])
        started = self._send("code.start", dict(ids, codeCapability=_id(authorized.get("codeCapability"), "code_capability")))
        parent["receipts"].append(started["receiptId"])
        self._code_invocation = {"id": _id(started.get("codeInvocationId"), "code_invocation"),
            "parent": parent, "tools": frozenset(tools), "receipts": [], "calls": 0, "cleanup_guard": cleanup_guard}
        return frozenset(tools)

    def end_code(self, result, status):
        invocation = self._code_invocation
        if invocation is None:
            return
        parent = _ADMISSION.get()
        if parent is not invocation["parent"] or not self._code_tool_lock.acquire(blocking=False):
            self._fenced = True
            raise EngineeringFault("code_cleanup_unconfirmed")
        try:
            # Exclude late buffered SDK RPC calls throughout absence checks and
            # host completion. No inherited call can begin after this proof.
            if invocation.get("cleanup_guard") is not None:
                invocation["cleanup_guard"]()
            ended = self._send("code.end", {"toolCallId": parent["toolCallId"], "admissionId": parent["admissionId"],
                "codeInvocationId": invocation["id"], "status": status, "resultHash": digest(result),
                "operationReceipts": list(invocation["receipts"])})
            parent["receipts"].append(ended["receiptId"])
            self._code_invocation = None
        except Exception:
            self._fenced = True
            raise EngineeringFault("code_process_cleanup_unconfirmed")
        finally:
            self._code_tool_lock.release()

    def inherited_middleware(self, tool_name, args, original_args, next_call, task_id, session_id):
        """Actual native core handlers called by the confined native code SDK.

        The host mints these nested admissions from the original code call;
        they are never presented as additional model-observed tool calls.
        """
        parent = _ADMISSION.get()
        invocation = self._code_invocation
        acquired = False
        token = None
        nested = None
        try:
            self._guard()
            if (invocation is None or invocation["parent"] is not parent or not parent["active"]
                    or task_id != self.binding["taskId"] or session_id not in ("", self.binding["sessionId"])
                    or tool_name not in invocation["tools"] or tool_name not in self.native_entries
                    or not isinstance(args, dict) or args != original_args or len(canonical_json(args).encode()) > 262144):
                raise EngineeringFault("unbound_inherited_call")
            if tool_name == "terminal" and any(args.get(k) for k in ("background", "pty", "notify_on_complete", "watch_patterns", "force")):
                raise EngineeringFault("inherited_process_mode_denied")
            if args.get("cross_profile"):
                raise EngineeringFault("cross_profile_denied")
            entry = self.registry.get_entry(tool_name)
            if entry is not self.native_entries[tool_name] or entry.handler is not self._handlers[tool_name]:
                raise EngineeringFault("native_handler_changed")
            acquired = self._code_tool_lock.acquire(blocking=False)
            if not acquired or self._code_invocation is not invocation or invocation["calls"] >= 50:
                raise EngineeringFault("inherited_call_limit")
            invocation["calls"] += 1
            call_id = "code-" + uuid.uuid4().hex
            # Nested UUIDs have a separate per-invocation 50-call ceiling;
            # they do not consume the observed-model-call dedupe allowance.
            started = self._send("tool.begin", {"toolCallId": call_id, "toolName": tool_name,
                "originalArgs": original_args, "effectiveArgs": args, "codeInvocationId": invocation["id"],
                "parentToolCallId": parent["toolCallId"], "parentAdmissionId": parent["admissionId"]})
            invocation["receipts"].append(started["receiptId"])
            nested = {"session": self, "toolCallId": call_id, "toolName": tool_name, "args": copy.deepcopy(args),
                "admissionId": _id(started.get("admissionId"), "admission_id"), "active": True,
                "receipts": [], "codeInvocationId": invocation["id"]}
            token = _ADMISSION.set(nested)
            try:
                if tool_name in NATIVE_TOOLS - {"terminal"}:
                    from tools.terminal_tool import get_session_cwd
                    self.environment.cwd = get_session_cwd(task_id)
                result = next_call(copy.deepcopy(args))
                if len(canonical_json(result).encode()) > self.max_result_bytes:
                    raise EngineeringFault("native_result_limit")
                status = "completed"
            except Exception:
                status, result = "failed", json.dumps({"error": "native_tool_failed"})
            nested["active"] = False
            ended = self._send("tool.end", {"toolCallId": call_id, "admissionId": nested["admissionId"],
                "status": status, "resultHash": digest(result), "operationReceipts": list(nested["receipts"]),
                "codeInvocationId": invocation["id"]})
            invocation["receipts"].append(ended["receiptId"])
            return result
        except Exception:
            return json.dumps({"error": "engineering_tool_blocked", "status": "blocked"})
        finally:
            if nested is not None:
                nested["active"] = False
            if token is not None:
                _ADMISSION.reset(token)
            if acquired:
                self._code_tool_lock.release()

    def task_rpc(self, operation, arguments):
        admission = _ADMISSION.get()
        if admission is None or admission["session"] is not self or not admission["active"]:
            raise EngineeringFault("unbound_task_operation")
        expected = {"delegate.run": "delegate_task", "code.run": "execute_code"}.get(operation)
        if expected is None or admission["toolName"] != expected or not isinstance(arguments, dict) or "operationId" in arguments:
            raise EngineeringFault("invalid_task_operation")
        reply = self._send("task.operation", {"toolCallId": admission["toolCallId"],
            "admissionId": admission["admissionId"], "operation": operation,
            "arguments": dict(arguments, operationId=uuid.uuid4().hex)})
        if not isinstance(reply.get("result"), dict):
            self._fenced = True
            raise EngineeringFault("invalid_task_result")
        admission["receipts"].append(reply["receiptId"])
        return copy.deepcopy(reply["result"])

    def middleware(self, *, tool_name, args, original_args, next_call,
                   task_id="", session_id="", tool_call_id="", **context):
        """Pinned native tool_execution callback: denial returns, never falls through.

        Hermes catches callback errors before next_call and continues dispatch.
        Consequently all pre-dispatch failures must become a terminal result.
        The environment independently enforces admission as a second boundary.
        """
        current = _ADMISSION.get()
        if current is not None and current.get("session") is self and current.get("toolName") == "execute_code":
            return self.inherited_middleware(tool_name, args, original_args, next_call, task_id, session_id)
        acquired = False
        token = None
        admission = None
        self._turn_tool_counts["toolCalls"] += 1
        tool_ordinal = self._turn_tool_counts["toolCalls"]
        try:
            self._guard()
            if self.environment is not None and self.environment._fenced:
                raise EngineeringFault("environment_fenced")
            if not self.turn_id or task_id != self.binding["taskId"] or session_id != self.binding["sessionId"]:
                raise EngineeringFault("native_identity_mismatch")
            _id(tool_call_id, "tool_call_id")
            if tool_name not in self.native_entries or tool_call_id in self._calls:
                raise EngineeringFault("tool_not_allowed_or_replayed")
            if len(self._calls) >= self.max_tool_calls:
                raise EngineeringFault("tool_limit")
            if not isinstance(args, dict) or not isinstance(original_args, dict) or args != original_args:
                raise EngineeringFault("tool_arguments_changed")
            if len(canonical_json(args).encode()) > 262144:
                raise EngineeringFault("tool_arguments_limit")
            if tool_name == "terminal" and (any(args.get(key) for key in ("pty", "notify_on_complete", "watch_patterns", "force")) or
                    (args.get("background") and "process" not in self.native_entries)):
                raise EngineeringFault("native_process_feature_not_implemented")
            if tool_name == "process" and args.get("action") not in ("list", "poll", "log", "wait", "kill"):
                raise EngineeringFault("native_process_action_not_implemented")
            if args.get("cross_profile") or (tool_name == "session_search" and args.get("profile")):
                raise EngineeringFault("cross_profile_denied")
            entry = self.registry.get_entry(tool_name)
            if entry is not self.native_entries[tool_name] or entry.handler is not self._handlers[tool_name]:
                raise EngineeringFault("native_handler_changed")
            acquired = self._tool_lock.acquire(blocking=False)
            if not acquired:
                raise EngineeringFault("parallel_native_tool_denied")
            # Consume locally BEFORE contacting the host. Uncertain admissions
            # must be reconciled; they are never replayed by the worker.
            self._calls.add(tool_call_id)
            reply = self._send("tool.begin", {"toolCallId": tool_call_id, "toolName": tool_name,
                "originalArgs": original_args, "effectiveArgs": args})
            admission = {"session": self, "toolCallId": tool_call_id, "toolName": tool_name,
                         "admissionId": _id(reply.get("admissionId"), "admission_id"),
                         "active": True, "receipts": [], "args": copy.deepcopy(args)}
            token = _ADMISSION.set(admission)
            status, result = "failed", json.dumps({"error": "native_tool_interrupted"})
            self.events.append({"event": "tool.begin", "toolCallId": tool_call_id, "receiptId": reply["receiptId"]})
            try:
                if tool_name in NATIVE_TOOLS - {"terminal"}:
                    # Native terminal `workdir` is transient: its session cwd
                    # stays put while BaseEnvironment.cwd tracks that command.
                    # File tools resolve/lock/report against the session cwd,
                    # but V4A headers and default searches execute relative to
                    # the environment cwd. Align those namespaces only after
                    # this exact file call has a host admission. A persistent
                    # terminal `cd` already updates the native session record.
                    from tools.terminal_tool import get_session_cwd
                    cwd = get_session_cwd(task_id)
                    if not isinstance(cwd, str) or not cwd.startswith("/"):
                        raise EngineeringFault("native_file_cwd_unbound")
                    self.environment.cwd = cwd
                result = next_call(copy.deepcopy(args))
                if len(canonical_json(result).encode()) > self.max_result_bytes:
                    raise EngineeringFault("native_result_limit")
                status = "completed"
                # Count only a native handler's explicit JSON error. Keep its
                # text out of diagnostics; a nonzero shell exit is not itself
                # a transport or tool-dispatch failure.
                try:
                    native_result = json.loads(result) if isinstance(result, str) else result
                except (ValueError, TypeError):
                    native_result = None
                if isinstance(native_result, dict) and native_result.get("error"):
                    self._turn_tool_counts["toolResultErrors"] += 1
                    if len(self._turn_tool_error_details) < 6:
                        # Bounded attribution only. Native messages may contain
                        # paths or private output; retain no error text and do
                        # not infer a cause from message substrings. This is
                        # the same canonical hash authenticated in tool.end.
                        self._turn_tool_error_details.append({
                            "toolOrdinal": tool_ordinal, "toolName": tool_name,
                            "phase": "native_result", "category": "native_reported_error",
                            "resultHash": digest(result),
                        })
            except Exception as error:
                with self._fault_lock:
                    self._first_fault = self._first_fault or worker_fault(error)
                self._turn_tool_counts["toolFailures"] += 1
                status, result = "failed", json.dumps({"error": "native_tool_failed"})
            finally:
                if tool_name == "execute_code" and self._code_invocation is not None:
                    self.end_code(result, status)
                admission["active"] = False
            end = self._send("tool.end", {"toolCallId": tool_call_id,
                "admissionId": admission["admissionId"], "status": status,
                "resultHash": digest(result), "operationReceipts": list(admission["receipts"])})
            self.events.append({"event": "tool.end", "toolCallId": tool_call_id, "receiptId": end["receiptId"]})
            if self._native_batch is not None:
                self._native_batch.append({"toolCallId": tool_call_id,
                    "admissionId": admission["admissionId"], "rawResultHash": digest(result)})
            return result
        except Exception:
            self._turn_tool_counts["toolBlocks"] += 1
            # An explicit value stops native middleware's fail-open fallback.
            return json.dumps({"error": "engineering_tool_blocked", "status": "blocked"})
        finally:
            if admission is not None:
                admission["active"] = False
            if token is not None:
                _ADMISSION.reset(token)
            if acquired:
                self._tool_lock.release()

    @contextlib.contextmanager
    def native_profile(self, *, cwd="/workspace", temp_dir="/tmp", native_context=None):
        """Install only backend/middleware seams, retaining exact native handlers."""
        self._guard()
        terminal = importlib.import_module("tools.terminal_tool")
        files = importlib.import_module("tools.file_tools")
        middleware = importlib.import_module("hermes_cli.middleware")
        from tools.registry import registry
        from gary_engineering_environment import GaryEnvironment, native_process_registry
        task_id = self.binding["taskId"]
        if self.environment is not None or task_id in terminal._active_environments:
            raise EngineeringFault("native_environment_collision")
        self.registry = registry
        self.native_context = native_context
        stack = contextlib.ExitStack()
        try:
            if native_context is not None:
                stack.enter_context(native_context.install(self))
            names = NATIVE_TOOLS | (native_context.tools if native_context is not None else set())
            for name in sorted(names):
                importlib.import_module(NATIVE_MODULES[name])
                entry = registry.get_entry(name)
                expected_module = NATIVE_MODULES[name]
                if entry is None or entry.handler.__module__ != expected_module:
                    raise EngineeringFault("native_registry_mismatch")
                self.native_entries[name] = entry
        except BaseException:
            stack.close()
            raise
        self._handlers = {name: entry.handler for name, entry in self.native_entries.items()}
        self.environment = GaryEnvironment(self.environment_rpc, cwd=cwd, temp_dir=temp_dir)
        self.environment._fault_observer = self._record_backend_fault
        if "process" in self.native_entries:
            processes = importlib.import_module("tools.process_registry")
            owned_registry = native_process_registry(self.environment, task_id=task_id,
                session_id=self.binding["sessionId"], current_admission=_ADMISSION.get)
            stack.enter_context(patch.object(processes, "process_registry", owned_registry))
        old_backends = terminal._CONTAINER_BACKENDS
        old_callbacks = middleware._get_middleware_callbacks
        old_factory = terminal._create_environment
        old_checks = {name: entry.check_fn for name, entry in self.native_entries.items()}
        def factory(*args, **kwargs):
            if kwargs.get("env_type") != "gary" or kwargs.get("task_id") != task_id:
                raise EngineeringFault("unbound_native_environment")
            return self.environment
        terminal._CONTAINER_BACKENDS = frozenset((*old_backends, "gary"))
        terminal._create_environment = factory
        middleware._get_middleware_callbacks = lambda kind: [self.middleware] if kind == "tool_execution" else []
        terminal.register_task_env_overrides(task_id, {"env_type": "gary", "cwd": cwd})
        terminal._active_environments[task_id] = self.environment
        # Availability checks are the backend integration seam. Neither native
        # handler nor native schema is replaced with a Gary wrapper.
        for entry in self.native_entries.values():
            entry.check_fn = lambda: not self._closed and not self._fenced
        try:
            yield self
        finally:
            files.clear_file_ops_cache(task_id)
            if terminal._active_environments.get(task_id) is self.environment:
                terminal._active_environments.pop(task_id, None)
            terminal._last_activity.pop(task_id, None)
            terminal.clear_task_env_overrides(task_id)
            terminal._CONTAINER_BACKENDS = old_backends
            terminal._create_environment = old_factory
            middleware._get_middleware_callbacks = old_callbacks
            for name, check in old_checks.items():
                self.native_entries[name].check_fn = check
            stack.close()

    def tool_schemas(self):
        if self.registry is None:
            raise EngineeringFault("native_profile_not_installed")
        schemas = [{"type": "function", "function": copy.deepcopy(self.native_entries[name].schema)}
                   for name in sorted(self.native_entries)]
        for schema in schemas:
            if schema["function"]["name"] == "terminal":
                parameters = schema["function"]["parameters"]["properties"]
                for name in ("pty", "notify_on_complete", "watch_patterns"):
                    parameters.pop(name, None)
                if "process" not in self.native_entries:
                    parameters.pop("background", None)
                schema["function"]["description"] = (
                    ("Run a command in the admitted Gary sandbox. Background handles are host-owned; cancellation closes the entire sandbox. PTY and notifications are not available in this profile. "
                     if "process" in self.native_entries else
                     "Run a foreground command in the admitted Gary sandbox. Background jobs, PTY and notifications are not available in this profile. ")
                    + schema["function"]["description"])
            if schema["function"]["name"] == "process":
                schema["function"]["parameters"]["properties"]["action"]["enum"] = ["list", "poll", "log", "wait", "kill"]
                schema["function"]["description"] = "Manage this task's host-owned background processes: list, poll, log, wait, or kill. Kill cancels the entire owned sandbox. Live stdin and PTY are unavailable."
            if schema["function"]["name"] == "skill_manage":
                schema["function"]["description"] = "Create, patch, edit, delete, write_file or remove_file in this task's skill drafts only. Approved skills remain immutable. Same-scope improvements are authorized within the task; promotion requires the host's bounded evaluation and independent review before later sessions can discover the new version."
            if schema["function"]["name"] == "delegate_task":
                schema["function"]["description"] = "Run up to two child agents in separate writable clones, one delegation level, within this task's audience, allocation and fixed deadline. Children execute and integrate serially; this call returns after they finish."
                properties = schema["function"]["parameters"]["properties"]
                for name in list(properties):
                    if name not in ("goal", "context", "tasks", "max_iterations", "role"):
                        del properties[name]
                properties["role"]["enum"] = ["leaf"]
                properties["role"]["description"] = "Children are leaves and cannot delegate."
                properties["tasks"]["maxItems"] = 2
                properties["tasks"]["description"] = "Up to two goals, run in separate clones and integrated serially."
                child = properties["tasks"]["items"]["properties"]
                child.pop("output_schema", None)
                child["role"]["enum"] = ["leaf"]
            if schema["function"]["name"] == "execute_code":
                code = importlib.import_module("tools.code_execution_tool")
                schema["function"] = code.build_execute_code_schema(
                    enabled_sandbox_tools=set(self.native_entries) & NATIVE_TOOLS, mode="strict")
                schema["function"]["description"] = schema["function"]["description"].replace(
                    "Scripts run in their own temp dir, not the session's CWD — use absolute paths (os.path.expanduser('~/.hermes/.env')) or terminal()/read_file() for user files.",
                    "Scripts run in a confined native-worker temporary directory. Use the native core tools to access /workspace and project dependencies in the separate admitted project sandbox.")
        return schemas

    def dispatch_native(self, name, arguments, call_id):
        """Fixture/embedded host entry using the actual native registry handler."""
        if self.registry is None:
            raise EngineeringFault("native_profile_not_installed")
        return self.middleware(tool_name=name, args=arguments, original_args=copy.deepcopy(arguments),
            task_id=self.binding["taskId"], session_id=self.binding["sessionId"], tool_call_id=call_id,
            next_call=lambda values: self.registry.dispatch(name, values, task_id=self.binding["taskId"],
                session_id=self.binding["sessionId"],
                **(self.native_context.dispatch_kwargs.get(name, {}) if self.native_context else {})))

    def create_agent(self, *, model, client_factory, max_iterations=20, max_tokens=4096,
                     system_prompt="You are Gary. Complete the admitted engineering task using only the available tools."):
        """Construct the real AIAgent using an injected guarded model client.

        No default HTTP/provider transport exists here. The trusted host client
        performs spend admission and observes model tool calls before returning
        them. All native fallback/retry/auxiliary routes remain disabled.
        """
        self._guard()
        if not callable(client_factory) or self.registry is None:
            raise EngineeringFault("missing_guarded_model_client_or_profile")
        if not isinstance(system_prompt, str) or not system_prompt or len(system_prompt.encode()) > 262144:
            raise EngineeringFault("invalid_host_system_prompt")
        import providers
        providers._REGISTRY.clear()
        providers._ALIASES.clear()
        providers._PROVIDER_LIST_CACHE = []
        providers._discovered = True
        from run_agent import AIAgent
        session = self
        class BoundEngineeringAgent(AIAgent):
            @staticmethod
            def _uniquify_tool_call_ids(tool_calls):
                # The host observed these exact IDs. Never repair an identity
                # or silently drop a separately admitted repeated command.
                ids = [getattr(call, "id", None) for call in tool_calls]
                if (any(not isinstance(value, str) or not value for value in ids)
                        or len(set(ids)) != len(ids) or any(value in session._calls for value in ids)):
                    session._fenced = True
                    raise EngineeringFault("native_call_identity_replayed")
                return tool_calls

            @staticmethod
            def _deduplicate_tool_calls(tool_calls):
                BoundEngineeringAgent._uniquify_tool_call_ids(tool_calls)
                return tool_calls

            def _build_system_prompt(self, system_message=None):
                return system_prompt

            def _create_openai_client(self, client_kwargs, *, reason, shared):
                session._guard()
                return client_factory(dict(client_kwargs), reason=reason, shared=shared)

            def _handle_max_iterations(self, messages, api_call_count):
                session._turn_iteration_limit = True
                # Native contract is str. An empty response avoids inventing
                # an assistant message without a host-observed model receipt;
                # native finalization marks this exhausted turn incomplete.
                return ""

            def _execute_tool_calls(self, message, messages, effective_task_id, api_call_count=0):
                session._guard()
                for call in message.tool_calls or []:
                    if call.function.name not in session.native_entries or not call.id:
                        raise EngineeringFault("unapproved_native_tool")
                if session._native_batch is not None:
                    raise EngineeringFault("native_batch_overlap")
                prefix = _native_messages(messages)
                start = len(messages)
                ids = [call.id for call in message.tool_calls or []]
                records = [] if session.result_presentation == "native_batch" else None
                session._native_batch = records
                self._executing_tools = True
                try:
                    result = self._execute_tool_calls_sequential(message, messages, effective_task_id, api_call_count)
                    if records is not None:
                        # Native warnings, result persistence, subdirectory
                        # hints, model conversion and aggregate budgeting all
                        # finish inside the native executor. Authenticate that
                        # final presentation separately from each raw result.
                        # This receipt grants no further environment authority.
                        if _native_messages(messages[:start]) != prefix:
                            raise EngineeringFault("native_batch_history_changed")
                        rows = native_history(messages)[len(prefix):]
                        if ([call.id for call in message.tool_calls or []] != ids
                                or len(rows) != len(ids) or len(records) != len(ids)
                                or any(row.get("role") != "tool" or row.get("tool_call_id") != call_id
                                       or record["toolCallId"] != call_id
                                       or not isinstance(row.get("content"), str)
                                       for row, record, call_id in zip(rows, records, ids))):
                            # Guardrail/interrupt-skipped calls have no admission;
                            # they cannot acquire a fabricated result receipt.
                            raise EngineeringFault("native_batch_result_mismatch")
                        for record, row in zip(records, rows):
                            if len(canonical_json(row["content"]).encode()) > session.max_result_bytes:
                                raise EngineeringFault("native_presentation_limit")
                            session._send("tool.presentation", dict(record, resultHash=digest(row["content"])))
                    return result
                except BaseException:
                    # AIAgent catches ordinary executor exceptions. A failed
                    # presentation/identity proof must also fence future model
                    # requests rather than become an unauthenticated tool row.
                    session._fenced = True
                    raise
                finally:
                    session._native_batch = None
                    self._executing_tools = False

            def _build_api_kwargs(self, messages, tools_for_api=None):
                session._guard()
                values = super()._build_api_kwargs(messages, tools_for_api=tools_for_api)
                # This engineering transport intentionally exposes one exact
                # host-reviewed Chat Completions dialect, without discovery.
                for key in ("max_completion_tokens", "max_output_tokens"):
                    values.pop(key, None)
                values.update(max_tokens=max_tokens, temperature=0.3, stream=False)
                return values
        agent = BoundEngineeringAgent(model=model, provider="custom", api_mode="chat_completions",
            base_url="https://gary.invalid/v1", api_key="injected-transport-only",
            enabled_toolsets=sorted({entry.toolset for entry in self.native_entries.values()}),
            disabled_toolsets=[], max_iterations=max_iterations, max_tokens=max_tokens,
            quiet_mode=True, verbose_logging=False, save_trajectories=False,
            skip_context_files=True, load_soul_identity=False, skip_memory=True,
            skip_background_review=True, session_db=None, fallback_model=[], credential_pool=None,
            checkpoints_enabled=False, session_id=self.binding["sessionId"], platform="gary")
        agent.tools = self.tool_schemas()
        agent._gary_system_prompt = system_prompt
        agent.valid_tool_names = set(self.native_entries)
        agent._disable_streaming = True
        agent._skip_mcp_refresh = True
        agent._persist_disabled = True
        agent.compression_enabled = False
        # Hermes counts attempts here (range(max_retries)); one means no retry.
        agent._api_max_retries = 1
        agent._fallback_chain = []
        agent._fallback_model = None
        if self.native_context:
            self.native_context.configure_agent(agent)
        return agent

    def run_turn(self, agent, *, turn_id, prompt, history=None, system_message=""):
        self.begin_turn(turn_id)
        if agent.session_id != self.binding["sessionId"]:
            raise EngineeringFault("native_agent_session_mismatch")
        if system_message and system_message != agent._gary_system_prompt:
            raise EngineeringFault("host_system_prompt_changed")
        self._turn_iteration_limit = False
        self._turn_tool_counts = dict(toolCalls=0, toolFailures=0, toolBlocks=0, toolResultErrors=0)
        self._turn_tool_error_details = []
        result = agent.run_conversation(prompt, system_message=system_message,
            conversation_history=copy.deepcopy(history or []), task_id=self.binding["taskId"])
        self._guard()
        if {item["function"]["name"] for item in agent.tools} != set(self.native_entries):
            raise EngineeringFault("native_profile_changed")
        if not isinstance(result, dict) or not isinstance(result.get("messages"), list):
            raise EngineeringFault("native_result_history_missing")
        result["messages"] = native_history(result["messages"])
        model_requests = result.get("api_calls")
        if type(model_requests) is not int or not 0 <= model_requests <= 2048:
            raise EngineeringFault("native_result_count_invalid")
        result["diagnostics"] = dict(
            outcome="iteration_limit" if self._turn_iteration_limit else
                "completed" if result.get("completed") is True else "incomplete",
            modelRequests=model_requests, **self._turn_tool_counts)
        if self._turn_tool_counts["toolResultErrors"]:
            result["diagnostics"].update(
                toolErrorDetails=copy.deepcopy(self._turn_tool_error_details),
                toolErrorDetailsTruncated=self._turn_tool_counts["toolResultErrors"] > 6)
        return result

    def close(self):
        if self._closed:
            return
        if self._tool_lock.locked():
            raise EngineeringFault("close_during_native_tool")
        if self.native_context is not None:
            self.native_context.close()
        if self.environment is not None:
            self.environment.cleanup()
        else:
            self.environment_rpc("close", {})


class EngineeringStdio:
    """Bounded request/reply transport. This class never opens a socket."""
    def __init__(self, reader, writer, deadline_ms):
        from gary_runtime import _FrameReader
        self.reader = _FrameReader(reader)
        self.writer = writer
        self.deadline_ms = deadline_ms
        self._lock = threading.Lock()
        self._next_id = 0
        self._failed = False

    def read(self):
        from gary_runtime import _strict_json
        return _strict_json(self.reader.line(2 * 1024 * 1024, self.deadline_ms))

    def write(self, frame):
        raw = canonical_json(frame) + "\n"
        if len(raw.encode()) > 2 * 1024 * 1024:
            raise EngineeringFault("stdio_frame_limit")
        self.writer.write(raw)
        self.writer.flush()

    def exchange(self, kind, body):
        with self._lock:
            if self._failed:
                raise EngineeringFault("stdio_transport_fenced")
            self._next_id += 1
            try:
                self.write({"type": "engineering.request", "id": self._next_id, "kind": kind, "body": body})
                reply = self.read()
                if not isinstance(reply, dict) or set(reply) != {"type", "id", "body"} or reply["type"] != "engineering.response" or type(reply["id"]) is not int or reply["id"] != self._next_id or not isinstance(reply["body"], dict):
                    raise EngineeringFault("stdio_reply_mismatch")
                return reply["body"]
            except BaseException:
                self._failed = True
                raise

    def model_client(self, options, *, reason, shared):
        import httpx
        from openai import OpenAI
        channel = self
        class Transport(httpx.BaseTransport):
            def handle_request(self, request):
                if request.method != "POST" or str(request.url) != "https://gary.invalid/v1/chat/completions":
                    raise EngineeringFault("model_route_denied")
                raw = request.read()
                if len(raw) > 2 * 1024 * 1024:
                    raise EngineeringFault("model_request_limit")
                from gary_runtime import _strict_json
                response = channel.exchange("model", _strict_json(raw))
                if set(response) != {"status", "body"} or type(response["status"]) is not int or not isinstance(response["body"], dict):
                    raise EngineeringFault("model_response_shape")
                return httpx.Response(response["status"], json=response["body"], request=request)
        # Ignore native URL/key/header discovery. The physical transport is
        # solely this pipe to the host's already guarded model route.
        return OpenAI(api_key="injected-transport-only", base_url="https://gary.invalid/v1",
                      max_retries=0, http_client=httpx.Client(transport=Transport(),
                          trust_env=False, follow_redirects=False))


def main(*, input_stream=None, output_stream=None):
    """Opt-in multi-turn worker; requires a host-controlled stdio launcher.

    First frame selects pinned source/scoped home and immutable task binding.
    No production service imports or calls this function automatically.
    """
    reader, writer = input_stream or sys.stdin, output_stream or sys.stdout
    # Admission must arrive promptly. Subsequent reads use the task deadline.
    channel = EngineeringStdio(reader, writer, int(time.time() * 1000) + 30000)
    session = None
    try:
        start = channel.read()
        allowed = {"type", "binding", "nativeSource", "scopedHome", "model", "maxIterations", "maxTokens", "systemPrompt", "resultPresentation", "nativeContext"}
        if not isinstance(start, dict) or set(start) - allowed or start.get("type") != "engineering.start":
            raise EngineeringFault("invalid_engineering_start")
        if not isinstance(start.get("binding"), dict):
            raise EngineeringFault("invalid_engineering_binding")
        session = EngineeringSession(start["binding"], lambda frame: channel.exchange("rpc", frame),
                                     result_presentation=start.get("resultPresentation", "raw"))
        channel.deadline_ms = session.deadline_ms
        iterations, tokens = start.get("maxIterations", 20), start.get("maxTokens", 4096)
        if type(iterations) is not int or not 1 <= iterations <= 50 or type(tokens) is not int or not 1 <= tokens <= 8192:
            raise EngineeringFault("invalid_model_limits")
        model = _id(start.get("model"), "model")
        # Capture stdout first; diagnostics from native code must never become
        # protocol frames. The saved writer remains the only protocol output.
        with scoped_home(start.get("scopedHome")), open(os.devnull, "w") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                load_native_source(start.get("nativeSource"))
                native_context = native_context_from_start(start["nativeContext"], start.get("scopedHome")) if "nativeContext" in start else None
                if native_context is not None:
                    session.scope_key = native_context.scope_key
                with session.native_profile(native_context=native_context):
                    agent = session.create_agent(model=model, client_factory=channel.model_client,
                        max_iterations=iterations, max_tokens=tokens,
                        system_prompt=start.get("systemPrompt", "You are Gary. Complete the admitted engineering task using only the available tools."))
                    channel.write({"type": "engineering.ready", "sessionId": session.binding["sessionId"],
                                   "tools": sorted(session.native_entries), "toolSchemas": session.tool_schemas()})
                    history = []
                    while True:
                        frame = channel.read()
                        if not isinstance(frame, dict):
                            raise EngineeringFault("invalid_turn_frame")
                        if frame == {"type": "engineering.close"}:
                            session.close()
                            channel.write({"type": "engineering.closed", "cleanupConfirmed": True})
                            return 0
                        if set(frame) - {"type", "turnId", "prompt", "history", "systemMessage"} or frame.get("type") != "engineering.turn" or not isinstance(frame.get("prompt"), str):
                            raise EngineeringFault("invalid_turn_frame")
                        from gary_runtime import _history
                        supplied_history = _history(frame.get("history", history))
                        result = session.run_turn(agent, turn_id=frame.get("turnId"), prompt=frame["prompt"],
                            history=supplied_history, system_message=frame.get("systemMessage", ""))
                        if isinstance(result, dict) and isinstance(result.get("messages"), list):
                            history = _history(result["messages"], native=True)
                        channel.write({"type": "engineering.result", "turnId": session.turn_id, "result": result})
    except Exception as error:
        # The trusted supervisor owns physical cleanup if a pipe/protocol fails.
        # Never attempt a fresh session/admission or command replay here.
        diagnostic = session.failure_diagnostic(error) if session else worker_fault(error)
        channel.write({"type": "engineering.error", "error": "engineering_runtime_failed",
                       "cleanupConfirmed": bool(session and session._closed),
                       "diagnostic": diagnostic})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
