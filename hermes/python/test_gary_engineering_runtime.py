"""Offline fixtures for the opt-in native engineering path.

Set GARY_NATIVE_SOURCE to the reviewed Hermes vendor tree. Native tests use
the real BaseEnvironment and registry file/terminal handlers. A fixture host
runs only the generated test commands in a temporary checkout directory; it
is NOT evidence for Docker confinement or a real provider/live deployment.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from gary_engineering_runtime import (
    EngineeringFault, EngineeringSession, ScopedNativeContext, NATIVE_TOOLS, PROTOCOL,
    digest, load_native_source, scoped_home,
)

MODULE_ROOT = Path(__file__).resolve().parent
TEST_ROOT = Path(os.environ.get("GARY_FIXTURE_ROOT", MODULE_ROOT)).resolve()
sys.path.insert(0, str(MODULE_ROOT))
SOURCE = os.environ.get("GARY_NATIVE_SOURCE")


def binding():
    return {"taskId": "fixture-task", "sessionId": "fixture-session", "ownerEpoch": "fixture-owner",
            "deadlineMs": int(time.time() * 1000) + 60000}


class FixtureHost:
    def __init__(self, root):
        self.root = Path(root)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.frames = []
        self.observed = {}
        self.active = None
        self.processes = {}
        self.starts = []
        self.reject_begin = False
        self.truncate = False
        self.closed = False

    def observe(self, call_id, name, arguments):
        self.observed[call_id] = (name, digest(arguments))

    def __call__(self, frame):
        assert frame["protocol"] == PROTOCOL
        assert frame["sequence"] == len(self.frames) + 1
        assert all(frame[key] == value for key, value in binding().items() if key != "deadlineMs")
        self.frames.append(copy.deepcopy(frame))
        payload = frame["payload"]
        result = {"ok": True, "receiptId": "receipt-" + str(len(self.frames))}
        if frame["kind"] == "tool.begin":
            expected = self.observed.pop(payload["toolCallId"], None)
            if self.reject_begin or expected != (payload["toolName"], digest(payload["originalArgs"])):
                return {"ok": False}
            assert payload["originalArgs"] == payload["effectiveArgs"]
            assert self.active is None
            self.active = payload["toolCallId"]
            return dict(result, admissionId="admit-" + self.active)
        if frame["kind"] == "tool.end":
            assert payload["toolCallId"] == self.active
            assert payload["admissionId"] == "admit-" + self.active
            assert isinstance(payload["operationReceipts"], list)
            self.active = None
            return result
        if frame["kind"] == "session.close":
            self.closed = True
            return dict(result, cleanupConfirmed=True)
        assert frame["kind"] == "environment.operation"
        assert payload["toolCallId"] == self.active
        assert payload["admissionId"] == "admit-" + self.active
        operation, arguments = payload["operation"], payload["arguments"]
        if operation == "execute":
            assert not self.closed
            command = arguments["command"].replace("/workspace", str(self.workspace))
            self.starts.append(arguments)
            # Static synthetic test commands, exact native wrapping, no service
            # credentials, no inherited environment, no package/network install.
            completed = subprocess.run(["/bin/bash", "-c", command], cwd=self.workspace,
                input=arguments.get("stdin"), capture_output=True, text=True, timeout=5,
                env={"PATH": "/usr/bin:/bin", "HOME": str(self.root), "LANG": "C.UTF-8"})
            process_id = "opaque-" + str(len(self.processes))
            output = (completed.stdout + completed.stderr).replace(str(self.workspace), "/workspace")
            self.processes[process_id] = {"output": output, "exitCode": completed.returncode}
            return dict(result, processId=process_id, status="running")
        process_id = arguments["processId"]
        assert process_id in self.processes
        if operation == "cancel":
            self.closed = True
            return dict(result, processId=process_id, cleanupConfirmed=True)
        assert operation == "poll"
        process = self.processes[process_id]
        output, process["output"] = process["output"][:4096], process["output"][4096:]
        return dict(result, processId=process_id, output=output, outputTruncated=self.truncate,
                    status="running" if process["output"] else "exited",
                    exitCode=None if process["output"] else process["exitCode"])


class ProtocolTests(unittest.TestCase):
    def test_unbound_operation_never_reaches_host(self):
        calls = []
        session = EngineeringSession(binding(), lambda value: calls.append(value))
        session.begin_turn("turn-1")
        with self.assertRaisesRegex(EngineeringFault, "unbound"):
            session.environment_rpc("execute", {"command": "ignored"})
        self.assertEqual(calls, [])

    def test_turn_replay_and_bound(self):
        session = EngineeringSession(binding(), None, max_turns=1)
        session.begin_turn("turn-1")
        for value in ("turn-1", "turn-2"):
            with self.assertRaisesRegex(EngineeringFault, "turn_replay_or_limit"):
                session.begin_turn(value)

    def test_clean_home_removes_operator_credentials(self):
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as root:
            with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-secret", "GITHUB_TOKEN": "fixture-token"}):
                with scoped_home(Path(root).resolve(), restore=True):
                    self.assertNotIn("OPENAI_API_KEY", os.environ)
                    self.assertNotIn("GITHUB_TOKEN", os.environ)
                    self.assertEqual(os.environ["TERMINAL_ENV"], "gary")
                self.assertEqual(os.environ["OPENAI_API_KEY"], "fixture-secret")

    def test_uncertain_admission_consumed_and_fences(self):
        session = EngineeringSession(binding(), lambda _: (_ for _ in ()).throw(OSError("lost")))
        session.begin_turn("turn-1")
        entry = type("Entry", (), {"handler": staticmethod(lambda _: None)})()
        session.native_entries = {"read_file": entry}
        session._handlers = {"read_file": entry.handler}
        session.registry = type("Registry", (), {"get_entry": lambda _, name: entry})()
        dispatched = []
        result = session.middleware(tool_name="read_file", args={}, original_args={},
            next_call=lambda args: dispatched.append(args), task_id="fixture-task",
            session_id="fixture-session", tool_call_id="call-1")
        self.assertEqual(json.loads(result)["status"], "blocked")
        self.assertFalse(dispatched)
        self.assertEqual(session._calls, {"call-1"})
        self.assertTrue(session._fenced)


@unittest.skipUnless(SOURCE, "GARY_NATIVE_SOURCE not set; native dependencies/source must be supplied")
class NativeHandlerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        cls.root = Path(cls.directory.name).resolve()
        cls.home = scoped_home(cls.root / "home-scope", restore=True)
        cls.home.__enter__()
        cls.network = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        cls.network.__enter__()
        try:
            load_native_source(Path(SOURCE))
            # Native modules, not replacements/mocks.
            import tools.terminal_tool
            import tools.file_tools
        except Exception:
            cls.network.__exit__(None, None, None)
            cls.home.__exit__(None, None, None)
            cls.directory.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.network.__exit__(None, None, None)
        cls.home.__exit__(None, None, None)
        cls.directory.cleanup()

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(dir=self.root)
        root = Path(self.fixture.name)
        (root / "remote-tmp").mkdir()
        self.host = FixtureHost(root)
        self.session = EngineeringSession(binding(), self.host)
        self.profile = self.session.native_profile(temp_dir=str(root / "remote-tmp"))
        self.profile.__enter__()
        self.session.begin_turn("turn-1")
        self.call_count = 0

    def tearDown(self):
        self.session.close()
        self.profile.__exit__(None, None, None)
        self.fixture.cleanup()

    def call(self, name, arguments):
        self.call_count += 1
        call_id = "call-" + str(self.call_count)
        self.host.observe(call_id, name, arguments)
        return json.loads(self.session.dispatch_native(name, arguments, call_id))

    def scoped_profile(self, tools):
        self.session.close()
        self.profile.__exit__(None, None, None)
        root = Path(self.fixture.name) / "scoped"
        root.mkdir()
        for name in ("approved", "drafts", "memory", "remote-tmp"):
            (root / name).mkdir()
        self.host = FixtureHost(root)
        self.session = EngineeringSession(dict(binding(), scopeKey="fixture-scope"), self.host)
        context = ScopedNativeContext(scope_key="fixture-scope", tools=tools,
            approved_skills=root / "approved", draft_skills=root / "drafts", memory_dir=root / "memory")
        self.profile = self.session.native_profile(temp_dir=str(root / "remote-tmp"), native_context=context)
        self.profile.__enter__()
        self.session.begin_turn("scoped-turn")
        return root

    def test_native_background_process_wait_and_exact_handles(self):
        self.scoped_profile({"process"})
        result = self.call("terminal", {"command": "printf 'background-native\\n'", "background": True})
        self.assertEqual(result.get("exit_code"), 0, result)
        process_id = result["session_id"]
        self.assertTrue(process_id.startswith("opaque-"))
        self.assertIsNone(result["pid"])
        before = len(self.host.frames)
        unknown = self.call("process", {"action": "poll", "session_id": process_id[:-1]})
        self.assertIn("error", unknown, unknown)
        self.assertFalse(any(frame["kind"] == "environment.operation" for frame in self.host.frames[before:]))
        result = self.call("process", {"action": "wait", "session_id": process_id, "timeout": 1})
        self.assertIn("background-native", json.dumps(result))
        result = self.call("process", {"action": "log", "session_id": process_id, "limit": 1})
        self.assertIn("background-native", json.dumps(result))
        self.assertEqual(len(self.host.starts), 2)  # native session snapshot + one user command

    def test_native_todo_memory_and_skill_scopes(self):
        root = self.scoped_profile({"todo", "memory", "skills_list", "skill_view", "skill_manage"})
        approved = root / "approved" / "approved-test"
        approved.mkdir()
        approved_text = "---\nname: approved-test\ndescription: Fixture approved skill\n---\n# Approved\nUse only the fixture.\n"
        (approved / "SKILL.md").write_text(approved_text)
        todo = self.call("todo", {"todos": [{"id": "one", "content": "fixture task", "status": "in_progress"}]})
        self.assertNotIn("error", todo, todo)
        self.assertIn("fixture task", json.dumps(self.call("todo", {})))
        memory = self.call("memory", {"target": "memory", "action": "add", "content": "fixture scoped memory"})
        self.assertNotIn("error", memory, memory)
        self.assertIn("fixture scoped memory", (root / "memory" / "MEMORY.md").read_text())
        listed = self.call("skills_list", {})
        self.assertIn("approved-test", json.dumps(listed), listed)
        viewed = self.call("skill_view", {"name": "approved-test"})
        self.assertIn("Use only the fixture", json.dumps(viewed), viewed)
        draft_text = "---\nname: draft-test\ndescription: Fixture candidate only\n---\n# Draft\nNot active.\n"
        draft = self.call("skill_manage", {"action": "create", "name": "draft-test", "content": draft_text})
        self.assertNotIn("error", draft, draft)
        self.assertTrue((root / "drafts" / "draft-test" / "SKILL.md").is_file())
        self.assertEqual((approved / "SKILL.md").read_text(), approved_text)
        self.assertNotIn("draft-test", json.dumps(self.call("skills_list", {})))
        self.assertFalse(self.host.starts)

    def test_real_native_files_patch_pagination_and_terminal_across_turns(self):
        schemas = self.session.tool_schemas()
        self.assertEqual({schema["function"]["name"] for schema in schemas}, NATIVE_TOOLS)
        result = self.call("write_file", {"path": "/workspace/example.txt", "content": "alpha\nbeta\ngamma\n"})
        self.assertNotIn("error", result, result)
        result = self.call("read_file", {"path": "/workspace/example.txt", "offset": 2, "limit": 1})
        self.assertIn("beta", json.dumps(result))
        self.assertNotIn("gamma", json.dumps(result))
        result = self.call("patch", {"path": "/workspace/example.txt", "old_string": "beta", "new_string": "delta"})
        self.assertNotIn("error", result, result)
        self.assertEqual((self.host.workspace / "example.txt").read_text(), "alpha\ndelta\ngamma\n")
        result = self.call("terminal", {"command": "mkdir -p subdir; cd subdir; export GARY_FIXTURE_VALUE=continued"})
        self.assertEqual(result["exit_code"], 0, result)
        self.session.begin_turn("turn-2")
        result = self.call("terminal", {"command": "printf '%s\\n' \"$GARY_FIXTURE_VALUE\"; pwd"})
        self.assertEqual(result["exit_code"], 0, result)
        self.assertIn("continued", result["output"])
        self.assertIn("/workspace/subdir", result["output"])
        self.assertTrue(all(frame["payload"].get("operationReceipts") for frame in self.host.frames if frame["kind"] == "tool.end"))
        self.assertEqual(len(self.session.events), 10)

    def test_denied_original_call_never_reaches_native_runner(self):
        self.host.reject_begin = True
        result = self.call("terminal", {"command": "printf forbidden"})
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(self.host.starts, [])

    def test_native_v4a_uses_task_cwd_after_transient_workdir(self):
        remote_temp = self.host.root / "remote-tmp"
        result = self.call("terminal", {"command": "pwd", "workdir": str(remote_temp)})
        self.assertEqual(result["exit_code"], 0, result)
        self.assertEqual(self.session.environment.cwd, str(remote_temp))
        added = self.call("patch", {"mode": "patch", "patch":
            "*** Begin Patch\n*** Add File: src/value.txt\n+original\n*** End Patch"})
        self.assertNotIn("error", added, added)
        self.assertEqual(added["resolved_path"], "/workspace/src/value.txt")
        self.assertTrue((self.host.workspace / "src/value.txt").is_file(), added)
        self.assertEqual((self.host.workspace / "src/value.txt").read_text(), "original")
        self.assertFalse((remote_temp / "src/value.txt").exists())
        self.call("terminal", {"command": "pwd", "workdir": str(remote_temp)})
        updated = self.call("patch", {"mode": "patch", "patch":
            "*** Begin Patch\n*** Update File: src/value.txt\n@@\n-original\n+changed\n*** End Patch"})
        self.assertNotIn("error", updated, updated)
        self.assertEqual((self.host.workspace / "src/value.txt").read_text(), "changed")
        self.assertFalse((remote_temp / "src/value.txt").exists())

    def test_native_v4a_keeps_persistent_cd_after_transient_workdir(self):
        result = self.call("terminal", {"command": "mkdir -p nested; cd nested"})
        self.assertEqual(result["exit_code"], 0, result)
        remote_temp = self.host.root / "remote-tmp"
        self.call("terminal", {"command": "pwd", "workdir": str(remote_temp)})
        added = self.call("patch", {"mode": "patch", "patch":
            "*** Begin Patch\n*** Add File: kept.txt\n+persistent directory\n*** End Patch"})
        self.assertNotIn("error", added, added)
        self.assertEqual(added["resolved_path"], "/workspace/nested/kept.txt")
        self.assertEqual((self.host.workspace / "nested/kept.txt").read_text(), "persistent directory")
        self.assertFalse((remote_temp / "kept.txt").exists())
        self.assertFalse((self.host.workspace / "kept.txt").exists())

    def test_denied_v4a_does_not_change_cwd_or_execute_after_transient_workdir(self):
        remote_temp = self.host.root / "remote-tmp"
        self.call("terminal", {"command": "pwd", "workdir": str(remote_temp)})
        starts = len(self.host.starts)
        self.host.reject_begin = True
        denied = self.call("patch", {"mode": "patch", "patch":
            "*** Begin Patch\n*** Add File: blocked.txt\n+blocked\n*** End Patch"})
        self.assertEqual(denied["status"], "blocked")
        self.assertEqual(len(self.host.starts), starts)
        self.assertEqual(self.session.environment.cwd, str(remote_temp))
        self.assertFalse((self.host.workspace / "blocked.txt").exists())
        self.assertFalse((remote_temp / "blocked.txt").exists())

    def test_native_file_reads_drain_multiple_output_chunks_before_patch(self):
        # Internal reads feed the native patch algorithm. All output must be
        # delivered before the host reports exited, even after its OS process
        # ended. The fixture mirrors that required host protocol contract.
        original = "".join("line-%04d %s\n" % (i, "x" * 64) for i in range(600)) + "replace-near-end\n"
        target = self.host.workspace / "large.txt"
        target.write_text(original)
        changed = self.call("patch", {"path": "large.txt", "old_string": "replace-near-end",
                                      "new_string": "verified-near-end"})
        self.assertNotIn("error", changed, changed)
        self.assertEqual(target.read_text(), original.replace("replace-near-end", "verified-near-end"))
        self.assertGreater(len(original), 32768)

    def test_replay_and_unsupported_background_do_not_start(self):
        result = self.call("terminal", {"command": "printf once"})
        self.assertEqual(result["exit_code"], 0, result)
        starts = len(self.host.starts)
        replay = self.session.dispatch_native("terminal", {"command": "printf once"}, "call-1")
        self.assertEqual(json.loads(replay)["status"], "blocked")
        result = self.call("terminal", {"command": "printf twice", "background": True})
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(len(self.host.starts), starts)

    def test_native_middleware_denial_does_not_fail_open(self):
        from hermes_cli.middleware import run_tool_execution_middleware
        reached = []
        result = run_tool_execution_middleware("terminal", {"command": "printf forbidden"},
            lambda args: reached.append(args), original_args={"command": "different"},
            task_id="fixture-task", session_id="fixture-session", tool_call_id="call-denied")
        self.assertEqual(json.loads(result)["status"], "blocked")
        self.assertFalse(reached)
        self.assertFalse(self.host.starts)

    def test_truncated_internal_read_fences_without_replay(self):
        self.host.truncate = True
        result = self.call("read_file", {"path": "/workspace/example.txt"})
        self.assertIn("error", result)
        self.assertTrue(self.host.closed)
        starts = len(self.host.starts)
        self.call("terminal", {"command": "printf must-not-run"})
        self.assertEqual(len(self.host.starts), starts)

    def test_real_AIAgent_with_fake_provider_uses_native_handlers(self):
        from openai.types.chat import ChatCompletion
        host = self.host
        requests = []
        def create(**kwargs):
            requests.append(copy.deepcopy(kwargs))
            number = len(requests)
            if number == 1:
                name, args = "write_file", {"path": "/workspace/agent.txt", "content": "native-agent-fixture\n"}
            elif number == 2:
                name, args = "terminal", {"command": "cat /workspace/agent.txt"}
            elif number == 3:
                name, args = None, None
            else:
                raise AssertionError("unexpected model request/retry")
            message = {"role": "assistant", "content": None if name else "Native engineering fixture completed."}
            if name:
                call_id = "model-call-" + str(number)
                host.observe(call_id, name, args)
                message["tool_calls"] = [{"id": call_id, "type": "function", "function": {
                    "name": name, "arguments": json.dumps(args)}}]
            return ChatCompletion.model_validate({"id": "fixture-response-" + str(number),
                "object": "chat.completion", "created": 1, "model": "fixture-model",
                "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if name else "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        class Client:
            api_key = "fixture-not-a-credential"
            base_url = "https://gary.invalid/v1"
            chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
            def close(self):
                pass
        agent = self.session.create_agent(model="deepseek-v4-pro", client_factory=lambda *args, **kwargs: Client(),
                                          max_iterations=6, max_tokens=256)
        result = self.session.run_turn(agent, turn_id="agent-turn", prompt="Write the fixture and read it using terminal.")
        self.assertEqual(len(requests), 3, result)
        for request in requests:
            # timeout is a local SDK option; it is not serialized into JSON.
            self.assertFalse(set(request) - {"model", "messages", "tools", "max_tokens", "stream", "temperature", "tool_choice", "parallel_tool_calls", "timeout"}, request.keys())
            self.assertEqual(request["max_tokens"], 256)
            self.assertEqual(request["temperature"], 0.3)
            self.assertFalse(request["stream"])
        self.assertTrue(result.get("completed"), result)
        self.assertEqual(result["diagnostics"], {"outcome": "completed", "modelRequests": 3,
            "toolCalls": 2, "toolFailures": 0, "toolBlocks": 0, "toolResultErrors": 0})
        self.assertFalse(any(message["role"] == "system" for message in result["messages"]))
        self.assertIn("Native engineering fixture completed", result["final_response"])
        self.assertEqual((host.workspace / "agent.txt").read_text(), "native-agent-fixture\n")
        self.assertEqual([event["toolCallId"] for event in self.session.events if event["event"] == "tool.begin"],
                         ["model-call-1", "model-call-2"])

    def test_native_request_limit_has_no_unaccounted_summary_call(self):
        from openai.types.chat import ChatCompletion
        requests = []
        host = self.host
        def create(**kwargs):
            requests.append(kwargs)
            self.assertEqual(len(requests), 1, "native summary retry must be disabled")
            args = {"command": "printf bounded-native"}
            host.observe("bounded-call", "terminal", args)
            return ChatCompletion.model_validate({"id": "bounded-response", "object": "chat.completion",
                "created": 1, "model": "deepseek-v4-pro", "choices": [{"index": 0,
                "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                "tool_calls": [{"id": "bounded-call", "type": "function", "function": {
                    "name": "terminal", "arguments": json.dumps(args)}}]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        client = types.SimpleNamespace(api_key="fixture", base_url="https://gary.invalid/v1",
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)), close=lambda: None)
        agent = self.session.create_agent(model="deepseek-v4-pro", client_factory=lambda *a, **kw: client,
                                          max_iterations=1, max_tokens=256)
        result = self.session.run_turn(agent, turn_id="bounded-turn", prompt="Run the bounded native fixture.")
        self.assertEqual(len(requests), 1)
        self.assertFalse(result["completed"])
        self.assertEqual(result["diagnostics"], {"outcome": "iteration_limit", "modelRequests": 1,
            "toolCalls": 1, "toolFailures": 0, "toolBlocks": 0, "toolResultErrors": 0})
        self.assertEqual(result["messages"][-1]["role"], "tool")
        self.assertIn("bounded-native", result["messages"][-1]["content"])

    def test_three_native_model_requests_read_test_red_patch_green(self):
        """Synthetic repository only; no model service or project dependencies."""
        from openai.types.chat import ChatCompletion
        (self.host.workspace / "src").mkdir()
        (self.host.workspace / "CLAUDE.md").write_text("Change only src; demonstrate red then green.\n")
        source = self.host.workspace / "src/calculator.py"
        source.write_text("def double(value):\n    return value\n")
        requests = []
        host = self.host
        test_command = shlex.quote(sys.executable) + " src/calculator_test.py"
        batches = [
            [("read_file", {"path": "CLAUDE.md"}), ("read_file", {"path": "src/calculator.py"})],
            [("write_file", {"path": "src/calculator_test.py", "content":
                "from calculator import double\nassert double(3) == 6\nprint('regression-green')\n"}),
             ("terminal", {"command": test_command})],
            [("terminal", {"command": "pwd", "workdir": str(host.root / "remote-tmp")}),
             ("patch", {"mode": "patch", "patch":
                "*** Begin Patch\n*** Update File: src/calculator.py\n@@\n-    return value\n+    return value * 2\n*** End Patch"}),
             ("terminal", {"command": test_command})],
        ]
        def create(**kwargs):
            requests.append(copy.deepcopy(kwargs))
            number = len(requests)
            self.assertLessEqual(number, 3, "no extra model summary or retry")
            if number == 3:
                red = json.loads([m for m in kwargs["messages"] if m.get("role") == "tool"][-1]["content"])
                self.assertEqual(red["exit_code"], 1, red)
                self.assertIn("AssertionError", red["output"])
            calls = []
            for index, (name, args) in enumerate(batches[number - 1]):
                call_id = "engineering-%d-%d" % (number, index)
                host.observe(call_id, name, args)
                calls.append({"id": call_id, "type": "function", "function": {
                    "name": name, "arguments": json.dumps(args)}})
            return ChatCompletion.model_validate({"id": "engineering-%d" % number,
                "object": "chat.completion", "created": 1, "model": "deepseek-v4-pro",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": None, "tool_calls": calls}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        client = types.SimpleNamespace(api_key="fixture", base_url="https://gary.invalid/v1",
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)), close=lambda: None)
        agent = self.session.create_agent(model="deepseek-v4-pro", client_factory=lambda *a, **kw: client,
                                          max_iterations=3, max_tokens=8192)
        result = self.session.run_turn(agent, turn_id="engineering-turn", prompt=
            "Use three model requests to read instructions/source, add and run a failing test, then fix and retest.")
        self.assertEqual(len(requests), 3)
        self.assertFalse(result["completed"])
        self.assertEqual(result["diagnostics"], {"outcome": "iteration_limit", "modelRequests": 3,
            "toolCalls": 7, "toolFailures": 0, "toolBlocks": 0, "toolResultErrors": 0})
        self.assertIn("return value * 2", source.read_text())
        green = json.loads(result["messages"][-1]["content"])
        self.assertEqual(green["exit_code"], 0, green)
        self.assertIn("regression-green", green["output"])
        self.assertFalse((host.root / "remote-tmp/src/calculator.py").exists())


if __name__ == "__main__":
    unittest.main()
