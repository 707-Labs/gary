"""Pure adapter contract tests; no native Hermes imports or execution.

All native modules below are synthetic. Socket/process creation is forbidden
throughout every test, including adapter installation and fake dispatch.
"""
from __future__ import annotations

import contextlib
import contextvars
import copy
import json
import os
import socket
import subprocess
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, MagicMock

from gary_engineering_runtime import EngineeringFault, _ADMISSION
from gary_engineering_task_tools import NativeTaskTools, NativeCodeProcessBoundary, _snapshot_native_processes


def forbidden(*args, **kwargs):
    raise AssertionError("socket/process/default native execution is forbidden")


class FakeSession:
    scope_key = "synthetic-task-tool-scope"
    binding = {"taskId": "synthetic-task", "sessionId": "synthetic-session"}

    def __init__(self):
        self.calls = []
        self.closed = False
        self.failure = None
        self.result_mutator = lambda value: value
        self.active = self.peak = 0
        self.code_starts = []
        self.code_allowed_tools = {"terminal","read_file","write_file","patch","search_files"}

    def begin_code(self, source, cleanup_guard=None):
        self.code_starts.append(source)
        if cleanup_guard is not None: cleanup_guard()
        return self.code_allowed_tools

    def _guard(self):
        if self.closed:
            raise EngineeringFault("synthetic_session_closed")

    def task_rpc(self, operation, args):
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            self.calls.append((operation, copy.deepcopy(args)))
            if self.failure:
                raise self.failure
            if operation == "delegate.run":
                result = {"task_index": args["taskIndex"], "status": "completed",
                          "summary": "synthetic child result", "api_calls": 1,
                          "duration_seconds": 0.25}
            else:
                result = {"status": "success", "output": "synthetic code result",
                          "exit_code": 0, "tool_calls_made": 0, "duration_seconds": 0.1}
            return self.result_mutator(result)
        finally:
            self.active -= 1


class NativeTaskToolsTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for obj, name in ((socket, "socket"), (socket, "create_connection"),
                          (socket, "socketpair"), (subprocess, "Popen"),
                          (subprocess, "run"), (subprocess, "call"),
                          (subprocess, "check_call"), (subprocess, "check_output")):
            self.stack.enter_context(patch.object(obj, name, forbidden))
        for name in ("system", "fork", "posix_spawn", "posix_spawnp"):
            if hasattr(os, name):
                self.stack.enter_context(patch.object(os, name, forbidden))
        self.stack.enter_context(patch("gary_engineering_task_tools._snapshot_native_processes", return_value={1:"100", 2:"101"}))
        self.session = FakeSession()
        self.agent = types.SimpleNamespace(session_id=self.session.binding["sessionId"],
                                           _delegate_depth=17, _dispatch_delegate_task=forbidden)
        self.adapter = NativeTaskTools(scope_key=self.session.scope_key, delegation_depth=0)
        self.backend = "gary"
        self.guard_result = {"approved": True}
        self.guard_calls = []
        self.native_calls = []
        self.confined_result = None
        self.modules = self.fake_modules()
        self.stack.enter_context(patch.dict("sys.modules", self.modules))
        self.delegate = self.modules["tools.delegate_tool"]
        self.code = self.modules["tools.code_execution_tool"]
        self.terminal = self.modules["tools.terminal_tool"]
        self.approval = self.modules["tools.approval"]

    def fake_modules(self):
        modules = {name: types.ModuleType(name) for name in (
            "tools", "tools.delegate_tool", "tools.code_execution_tool", "tools.terminal_tool",
            "tools.approval", "tools.delegation_live_log", "tools.async_delegation")}
        modules["tools"].__path__ = []
        delegate = modules["tools.delegate_tool"]
        for name in ("_build_child_preserving_parent_tools", "_build_child_agent", "_run_single_child",
                     "_resolve_delegation_credentials", "_model_background_value", "_handle_control_action",
                     "_get_max_concurrent_children", "_get_max_spawn_depth", "_get_orchestrator_enabled",
                     "_get_worktree_isolation", "_capture_gateway_steer_authority", "_finalize_child_results"):
            setattr(delegate, name, forbidden)
        live = modules["tools.delegation_live_log"]
        live.create_live_transcripts = live.update_manifest_statuses = forbidden
        modules["tools.async_delegation"].dispatch_async_delegation_batch = forbidden
        terminal = modules["tools.terminal_tool"]
        terminal.register_container_alias = forbidden
        terminal._get_env_config = lambda: {"env_type": self.backend}
        approval = modules["tools.approval"]

        def guard(code, env_type, has_host_access=False):
            self.guard_calls.append((code, env_type, has_host_access))
            return copy.deepcopy(self.guard_result)

        approval.check_execute_code_guard = guard

        def delegate_task(goal=None, context=None, tasks=None, max_iterations=None,
                          role=None, background=None, output_schema=None, action=None,
                          subagent_id=None, message=None, parent_agent=None):
            self.native_calls.append("delegate_task")
            if action not in (None, "", "spawn"):
                return delegate._handle_control_action(action, subagent_id, message, parent_agent)
            if background:
                return modules["tools.async_delegation"].dispatch_async_delegation_batch()
            creds = delegate._resolve_delegation_credentials({}, parent_agent)
            task_list = tasks or [{"goal": goal, "context": context}]
            if len(task_list) > delegate._get_max_concurrent_children():
                raise AssertionError("native task limit")
            if isinstance(tasks, list) and len(tasks) == 1:
                return json.dumps({"error": "native one-item batch rejection"})
            live_id, writers, paths = live.create_live_transcripts(task_list, context)
            self.assertEqual((live_id, writers, paths), (None, [], []))
            children = [self.build_kwargs(i, task, len(task_list), parent_agent, creds)
                        for i, task in enumerate(task_list)]
            children = [delegate._build_child_preserving_parent_tools(**kwargs) for kwargs in children]

            def run(index):
                return delegate._run_single_child(index, task_list[index]["goal"], children[index], parent_agent,
                    owner_session_id="synthetic-untrusted-native-origin", owner_transport=None,
                    owner_session_record=None)

            if len(task_list) == 2:
                contexts = [contextvars.copy_context() for _ in task_list]
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(contexts[i].run, run, i) for i in (1, 0)]
                    results = [future.result() for future in futures]
                results.sort(key=lambda result: result["task_index"])
            else:
                results = [run(0)]
            delegate._finalize_child_results(results, task_list, children, parent_agent)
            live.update_manifest_statuses(live_id, results)
            return json.dumps({"results": results, "total_duration_seconds": 0.5})

        delegate.delegate_task = delegate_task

        def delegate_handler(args, **kwargs):
            return delegate.delegate_task(**{key: value for key, value in args.items() if key != "background"},
                background=delegate._model_background_value(args, kwargs.get("parent_agent")),
                parent_agent=kwargs.get("parent_agent"))

        delegate.registry_handler = delegate_handler
        code = modules["tools.code_execution_tool"]
        code._execute_remote = forbidden
        code.SANDBOX_ALLOWED_TOOLS = frozenset({"web_search", "terminal"})
        code._get_execution_mode = lambda: "project"
        code._load_config = lambda: {}

        def execute_code(source, task_id=None, enabled_tools=None):
            self.native_calls.append("execute_code")
            config = terminal._get_env_config()
            decision = approval.check_execute_code_guard(source, config["env_type"], has_host_access=False)
            if not decision.get("approved", False):
                return json.dumps({"status": "error", "error": decision.get("message", "native guard denied")})
            if config["env_type"] == "local":
                if self.confined_result is not None:
                    return json.dumps(self.confined_result)
                forbidden()
            return code._execute_remote(source, task_id, enabled_tools)

        code.execute_code = execute_code
        code._execute_code_handler = lambda args, **kwargs: code.execute_code(
            args.get("code"), kwargs.get("task_id"), kwargs.get("enabled_tools"))
        return modules

    @staticmethod
    def build_kwargs(index, task, count, parent, creds=None):
        creds = creds or dict.fromkeys(("model", "provider", "base_url", "api_key", "api_mode"))
        return {"task_index": index, "goal": task["goal"], "context": task.get("context"),
                "task_count": count, "parent_agent": parent, "max_iterations": 1, "toolsets": None,
                "model": creds["model"], "override_provider": creds["provider"],
                "override_base_url": creds["base_url"], "override_api_key": creds["api_key"],
                "override_api_mode": creds["api_mode"], "role": "leaf"}

    @contextlib.contextmanager
    def installed(self, adapter=None):
        adapter = adapter or self.adapter
        with adapter.install(self.session):
            adapter.configure_agent(self.agent)
            yield adapter

    @contextlib.contextmanager
    def admission(self, tool, original_args, **changes):
        value = {"session": self.session, "active": True, "toolName": tool,
                 "toolCallId": "synthetic-call", "admissionId": "synthetic-admission",
                 "receipts": [], "args": copy.deepcopy(original_args)}
        value.update(changes)
        token = _ADMISSION.set(value)
        try:
            yield value
        finally:
            _ADMISSION.reset(token)

    def test_public_functions_and_handlers_are_retained_and_seams_restore(self):
        original = {name: dict(vars(module)) for name, module in self.modules.items()}
        with self.installed():
            for name, attr in (("tools.delegate_tool", "delegate_task"),
                               ("tools.delegate_tool", "registry_handler"),
                               ("tools.code_execution_tool", "execute_code"),
                               ("tools.code_execution_tool", "_execute_code_handler")):
                self.assertIs(getattr(self.modules[name], attr), original[name][attr])
        for name, attrs in original.items():
            self.assertEqual(vars(self.modules[name]), attrs)
        self.assertEqual(self.agent._delegate_depth, 17)
        self.assertIs(self.agent._dispatch_delegate_task, forbidden)
        self.assertIsNone(self.adapter._session)

    def test_single_native_wrapper_uses_only_exact_host_operation(self):
        args = {"goal": "Review synthetic code", "context": "Synthetic bounded input"}
        with self.installed(), self.admission("delegate_task", args):
            result = json.loads(self.agent._dispatch_delegate_task(args))
        self.assertEqual(self.native_calls, ["delegate_task"])
        self.assertEqual(result["results"][0]["status"], "completed")
        self.assertEqual(self.session.calls, [("delegate.run", {"taskIndex": 0, **args})])

    def test_registry_fallback_forces_sync_and_preserves_handler(self):
        args = {"goal": "Synthetic native fallback"}
        with self.installed(), self.admission("delegate_task", args):
            self.delegate.registry_handler(args, parent_agent=self.agent)
        self.assertEqual(len(self.session.calls), 1)

    def test_two_native_batch_threads_serialize_host_operations_and_sort(self):
        args = {"tasks": [{"goal": "Synthetic first task", "context": "A"},
                           {"goal": "Synthetic second task", "context": "B"}]}
        with self.installed(), self.admission("delegate_task", args):
            result = json.loads(self.agent._dispatch_delegate_task(args))
        self.assertEqual([row["task_index"] for row in result["results"]], [0, 1])
        self.assertEqual(sorted(args["taskIndex"] for _, args in self.session.calls), [0, 1])
        self.assertEqual(self.session.peak, 1)

    def test_native_one_task_batch_validation_retained(self):
        args = {"tasks": [{"goal": "Synthetic single batch"}]}
        with self.installed(), self.admission("delegate_task", args):
            result = json.loads(self.agent._dispatch_delegate_task(args))
        self.assertIn("error", result)
        self.assertEqual(self.session.calls, [])

    def test_authority_bearing_and_invalid_delegation_options_fail_before_wrapper(self):
        variants = [{"background": value} for value in (True, "false", 0)]
        variants += [{"action": action} for action in ("list", "stop", "steer")]
        variants += [{"role": "orchestrator"}, {"subagent_id": "foreign"}, {"message": "steer"},
                     {"output_schema": {}}, {"provider": "external"}, {"max_iterations": True},
                     {"tasks": "[]"}, {"tasks": [{"goal": "x", "toolsets": []}]},
                     {"tasks": [{"goal": "x", "role": "orchestrator"}]},
                     {"tasks": [{"goal": "x"}] * 3}, {"context": {}}, {"goal": " "}]
        with self.installed():
            for extra in variants:
                with self.subTest(extra=extra):
                    args = {"goal": "Synthetic task", **extra}
                    with self.admission("delegate_task", args), self.assertRaises(EngineeringFault):
                        self.agent._dispatch_delegate_task(args)
        self.assertEqual(self.native_calls, [])
        self.assertEqual(self.session.calls, [])

    def test_depth_one_forbids_nested_delegation(self):
        adapter = NativeTaskTools(scope_key=self.session.scope_key, delegation_depth=1)
        args = {"goal": "Synthetic nested task"}
        with self.installed(adapter), self.admission("delegate_task", args), self.assertRaises(EngineeringFault):
            self.agent._dispatch_delegate_task(args)
        self.assertEqual(self.session.calls, [])

    def test_wrong_parent_changed_args_and_closed_session_fail(self):
        args = {"goal": "Synthetic identity task"}
        with self.installed(), self.admission("delegate_task", args):
            with self.assertRaises(EngineeringFault):
                self.delegate._model_background_value(args, types.SimpleNamespace(session_id=self.agent.session_id))
            with self.assertRaises(EngineeringFault):
                self.agent._dispatch_delegate_task({"goal": "changed"})
            self.session.closed = True
            with self.assertRaises(EngineeringFault):
                self.agent._dispatch_delegate_task(args)
        self.assertEqual(self.session.calls, [])

    def test_absent_expired_foreign_and_wrong_tool_admissions_fail(self):
        args = {"goal": "Synthetic bound task"}
        with self.installed():
            with self.assertRaises(EngineeringFault):
                self.agent._dispatch_delegate_task(args)
            for changes in ({"active": False}, {"active": 1}, {"session": FakeSession()},
                            {"toolName": "execute_code"}, {"args": None}):
                with self.subTest(changes=changes), self.admission("delegate_task", args, **changes):
                    with self.assertRaises(EngineeringFault):
                        self.agent._dispatch_delegate_task(args)

    def test_child_is_inert_bound_and_one_use_even_after_rpc_failure(self):
        args = {"goal": "Synthetic one-use child"}
        with self.installed(), self.admission("delegate_task", args):
            kwargs = self.build_kwargs(0, args, 1, self.agent)
            child = self.delegate._build_child_preserving_parent_tools(**kwargs)
            self.assertFalse(hasattr(child, "run_conversation"))
            with self.assertRaises(EngineeringFault):
                self.delegate._build_child_preserving_parent_tools(**kwargs)
            with self.assertRaises(EngineeringFault):
                self.delegate._run_single_child(0, args["goal"], object(), self.agent)
            self.session.failure = EngineeringFault("synthetic uncertain reply")
            with self.assertRaises(EngineeringFault):
                self.delegate._run_single_child(0, args["goal"], child, self.agent)
            self.session.failure = None
            with self.assertRaises(EngineeringFault):
                self.delegate._run_single_child(0, args["goal"], child, self.agent)
        self.assertEqual(len(self.session.calls), 1)

    def test_child_arguments_cannot_change_or_introduce_provider_authority(self):
        args = {"goal": "Synthetic exact child", "context": "scope"}
        changes = ({"goal": "changed"}, {"context": "changed"}, {"task_index": True},
                   {"task_index": 2}, {"task_count": 2}, {"task_count": True}, {"role": "orchestrator"},
                   {"toolsets": []}, {"model": "external"}, {"override_api_key": "synthetic-key"})
        with self.installed(), self.admission("delegate_task", args):
            for change in changes:
                with self.subTest(change=change), self.assertRaises(EngineeringFault):
                    self.delegate._build_child_preserving_parent_tools(
                        **{**self.build_kwargs(0, args, 1, self.agent), **change})
        self.assertEqual(self.session.calls, [])

    def test_failed_child_status_is_preserved_without_fabricated_completion(self):
        self.session.result_mutator = lambda result: {**result, "status": "failed", "summary": None,
                                                       "error": "synthetic failure"}
        args = {"goal": "Synthetic failed child"}
        with self.installed(), self.admission("delegate_task", args):
            result = json.loads(self.agent._dispatch_delegate_task(args))
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertEqual(result["results"][0]["error"], "synthetic failure")

    def test_malformed_host_child_results_are_terminal_and_not_retried(self):
        for change in ({"task_index": True}, {"task_index": 1}, {"status": "dispatched"},
                       {"api_calls": True}, {"api_calls": -1}, {"summary": {}},
                       {"duration_seconds": True}, {"duration_seconds": -1},
                       {"duration_seconds": float("nan")}):
            with self.subTest(change=change):
                self.session.result_mutator = lambda result: {**result, **change}
                args = {"goal": "Synthetic malformed result"}
                with self.installed(), self.admission("delegate_task", args):
                    with self.assertRaises((EngineeringFault, ValueError)):
                        self.agent._dispatch_delegate_task(args)
        self.assertEqual(len(self.session.calls), 9)

    def test_default_child_async_control_and_parent_alias_are_denied(self):
        with self.installed():
            for function in (self.delegate._build_child_agent, self.delegate._handle_control_action,
                             self.terminal.register_container_alias,
                             self.modules["tools.async_delegation"].dispatch_async_delegation_batch):
                with self.assertRaises(EngineeringFault):
                    function()
            self.assertFalse(self.delegate._get_worktree_isolation())
            self.assertFalse(self.delegate._get_orchestrator_enabled())
            self.assertEqual(self.delegate._get_max_spawn_depth(), 1)

    def test_code_retains_native_guard_and_public_dispatch_but_uses_only_host(self):
        args = {"code": "print('synthetic only; never executed')"}
        with self.installed(), self.admission("execute_code", args):
            result = json.loads(self.code._execute_code_handler(args, task_id=self.session.binding["taskId"],
                                                               enabled_tools=[]))
        self.assertEqual(result["output"], "synthetic code result")
        self.assertEqual(self.session.calls, [("code.run", args)])
        self.assertEqual(self.guard_calls, [(args["code"], "gary", False)])
        self.assertEqual(self.native_calls, ["execute_code"])

    def test_confined_code_uses_native_loop_only_after_guard_and_host_code_start(self):
        adapter=NativeTaskTools(scope_key=self.session.scope_key,delegation_depth=0,confined_code=True)
        args={"code":"synthetic never executed"};self.confined_result={"status":"success"}
        original=self.code.execute_code
        with self.installed(adapter),self.admission("execute_code",args):
            self.assertIs(self.code.execute_code,original)
            result=json.loads(self.code._execute_code_handler(args,task_id=self.session.binding["taskId"]))
            self.assertEqual(self.code.SANDBOX_ALLOWED_TOOLS,{"terminal","read_file","write_file","patch","search_files"})
            self.assertEqual(self.code._get_execution_mode(),"strict")
            self.assertEqual(self.code._load_config(),{"mode":"strict","timeout":300,"max_tool_calls":50})
            with self.assertRaisesRegex(EngineeringFault,"fallback"):
                self.code._execute_remote(args["code"],self.session.binding["taskId"],[])
        self.assertEqual(result,{"status":"success"})
        self.assertEqual(self.session.code_starts,[args["code"]]);self.assertEqual(self.session.calls,[])
        self.assertEqual(self.guard_calls,[(args["code"],"gary",False)])

    def test_confined_native_sdk_uses_exact_host_authorized_set_including_empty(self):
        for allowed in (set(),{"read_file"}):
            adapter=NativeTaskTools(scope_key=self.session.scope_key,delegation_depth=0,confined_code=True)
            self.session.code_allowed_tools=allowed;self.confined_result={"status":"success"}
            with self.installed(adapter),self.admission("execute_code",{"code":"synthetic"}):
                self.code._execute_code_handler({"code":"synthetic"},task_id=self.session.binding["taskId"])
                self.assertEqual(self.code.SANDBOX_ALLOWED_TOOLS,allowed)

    def test_confined_code_preserves_denial_and_nested_environment_is_still_gary(self):
        adapter=NativeTaskTools(scope_key=self.session.scope_key,delegation_depth=0,confined_code=True)
        self.guard_result={"approved":False,"message":"kept"};args={"code":"synthetic"}
        with self.installed(adapter),self.admission("execute_code",args):
            result=json.loads(self.code._execute_code_handler(args,task_id=self.session.binding["taskId"]))
            with self.admission("terminal",{"command":"synthetic"}):
                self.assertEqual(self.terminal._get_env_config()["env_type"],"gary")
        self.assertEqual(result["error"],"kept");self.assertEqual(self.session.code_starts,[])

    def test_native_code_guard_denial_is_preserved_and_no_host_operation_occurs(self):
        self.guard_result = {"approved": False, "message": "synthetic native denial"}
        args = {"code": "synthetic source"}
        with self.installed(), self.admission("execute_code", args):
            result = json.loads(self.code._execute_code_handler(args, task_id=self.session.binding["taskId"]))
        self.assertEqual(result["error"], "synthetic native denial")
        self.assertEqual(self.session.calls, [])

    def test_code_non_gary_backend_fails_before_native_guard_or_local_executor(self):
        args = {"code": "synthetic source"}
        with self.installed(), self.admission("execute_code", args):
            for backend in ("local", "docker", "ssh", None):
                with self.subTest(backend=backend), self.assertRaises(EngineeringFault):
                    self.backend = backend
                    self.code._execute_code_handler(args, task_id=self.session.binding["taskId"])
        self.assertEqual(self.session.calls, [])
        self.assertEqual(self.guard_calls, [])

    def test_code_changed_args_foreign_task_and_host_access_fail(self):
        args = {"code": "synthetic source"}
        with self.installed(), self.admission("execute_code", args):
            for source, task_id in (("changed", self.session.binding["taskId"]),
                                    (args["code"], "foreign"), (args["code"], None)):
                with self.subTest(source=source, task_id=task_id), self.assertRaises(EngineeringFault):
                    self.code._execute_remote(source, task_id, [])
            with self.assertRaises(EngineeringFault):
                self.approval.check_execute_code_guard(args["code"], "gary", has_host_access=True)
        with self.installed(), self.admission("execute_code", {**args, "command": "extra"}):
            with self.assertRaises(EngineeringFault):
                self.code._execute_code_handler(args, task_id=self.session.binding["taskId"])
        self.assertEqual(self.session.calls, [])

    def test_code_one_use_even_after_uncertain_host_rpc(self):
        args = {"code": "synthetic source"}
        with self.installed(), self.admission("execute_code", args):
            self.session.failure = EngineeringFault("synthetic lost response")
            with self.assertRaises(EngineeringFault):
                self.code._execute_code_handler(args, task_id=self.session.binding["taskId"])
            self.session.failure = None
            with self.assertRaises(EngineeringFault):
                self.code._execute_code_handler(args, task_id=self.session.binding["taskId"])
        self.assertEqual(len(self.session.calls), 1)

    def test_code_missing_or_expired_admission_cannot_use_retained_callback(self):
        with self.installed():
            remote = self.code._execute_remote
            with self.assertRaises(EngineeringFault):
                remote("synthetic source", self.session.binding["taskId"], [])
            with self.admission("execute_code", {"code": "synthetic source"}, active=False):
                with self.assertRaises(EngineeringFault):
                    remote("synthetic source", self.session.binding["taskId"], [])
        with self.admission("execute_code", {"code": "synthetic source"}), self.assertRaises(EngineeringFault):
            remote("synthetic source", self.session.binding["taskId"], [])

    def test_invalid_scope_depth_reinstall_and_unconfigured_agent_fail(self):
        for scope, depth in (("", 0), ("s", True), ("s", -1), ("s", 2)):
            with self.subTest(scope=scope, depth=depth), self.assertRaises(EngineeringFault):
                NativeTaskTools(scope_key=scope, delegation_depth=depth)
        with self.assertRaises(EngineeringFault):
            self.adapter.configure_agent(self.agent)
        foreign = NativeTaskTools(scope_key="foreign", delegation_depth=0)
        with self.assertRaises(EngineeringFault), foreign.install(self.session):
            pass
        with self.installed():
            with self.assertRaises(EngineeringFault), self.adapter.install(self.session):
                pass
            with self.assertRaises(EngineeringFault):
                self.adapter.configure_agent(self.agent)

    def test_install_failure_restores_all_preceding_patches(self):
        original = self.delegate._run_single_child
        del self.terminal.register_container_alias
        with self.assertRaises(AttributeError), self.adapter.install(self.session):
            pass
        self.assertIs(self.delegate._run_single_child, original)
        self.assertIsNone(self.adapter._session)

    def test_non_task_native_config_reads_are_unchanged(self):
        with self.installed():
            self.backend = "synthetic-other"
            self.assertEqual(self.terminal._get_env_config(), {"env_type": "synthetic-other"})


if __name__ == "__main__":
    unittest.main()


class NativeCodeProcessBoundaryTests(unittest.TestCase):
    def test_exact_idle_namespace_is_required_before_and_after_code(self):
        baseline={1:"10", 2:"20"}
        with patch("gary_engineering_task_tools._snapshot_native_processes",return_value=baseline):
            boundary=NativeCodeProcessBoundary();boundary.assert_current()
        for changed in ({1:"10",2:"20",3:"30"},{1:"10",2:"21"},{1:"10"}):
            with patch("gary_engineering_task_tools._snapshot_native_processes",side_effect=[baseline,baseline,changed]):
                boundary=NativeCodeProcessBoundary()
                with self.assertRaisesRegex(EngineeringFault,"cleanup_unconfirmed"):boundary.assert_current()

    def test_process_table_races_and_read_failures_never_claim_cleanup(self):
        baseline={1:"10",2:"20"}
        with patch("gary_engineering_task_tools._snapshot_native_processes",side_effect=[baseline,{1:"10",2:"20",3:"30"}]):
            with self.assertRaisesRegex(EngineeringFault,"unstable"):NativeCodeProcessBoundary()
        with patch("gary_engineering_task_tools._snapshot_native_processes",side_effect=[baseline,baseline,baseline,EngineeringFault("uncertain")]):
            boundary=NativeCodeProcessBoundary()
            with self.assertRaisesRegex(EngineeringFault,"uncertain"):boundary.assert_current()


    def test_proc_parser_binds_birth_with_parentheses_and_refuses_missing_entries(self):
        entry=MagicMock();entry.name="7"
        entry.__truediv__.return_value.read_text.return_value="7 (odd ) name) S "+" ".join(["0"]*18+["123"]+["0"]*8)
        directory=MagicMock();directory.iterdir.return_value=[entry]
        with patch("gary_engineering_task_tools.Path",return_value=directory),patch("gary_engineering_task_tools.sys.platform","linux"),patch("gary_engineering_task_tools.os.getpid",return_value=7):
            self.assertEqual(_snapshot_native_processes(),{7:"123"})
            entry.__truediv__.return_value.read_text.side_effect=FileNotFoundError()
            with self.assertRaisesRegex(EngineeringFault,"uncertain"):_snapshot_native_processes()
