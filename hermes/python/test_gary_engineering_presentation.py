"""Pinned native postprocessing + authenticated presentation, entirely offline."""
import copy
import json
import types
import unittest

from gary_engineering_runtime import EngineeringFault, EngineeringSession, digest, native_history
from test_gary_engineering_runtime import NativeHandlerTests, binding


class NativePresentationTests(NativeHandlerTests):
    def setUp(self):
        super().setUp()
        self.session.result_presentation = "native_batch"

    def _batch(self, calls, configure=None):
        from openai.types.chat import ChatCompletion
        self.requests = []
        def create(**kwargs):
            self.requests.append(copy.deepcopy(kwargs))
            if len(self.requests) == 1:
                wire = []
                for call_id, name, args in calls:
                    self.host.observe(call_id, name, args)
                    wire.append(dict(id=call_id, type="function",
                        function=dict(name=name, arguments=json.dumps(args))))
                message = dict(role="assistant", content=None, tool_calls=wire)
                finish = "tool_calls"
            else:
                self.assertEqual(len(self.requests), 2)
                rows = [row for row in kwargs["messages"] if row["role"] == "tool"]
                presentations = {frame["payload"]["toolCallId"]: frame["payload"]
                    for frame in self.host.frames if frame["kind"] == "tool.presentation"}
                self.assertEqual([row["tool_call_id"] for row in rows], [call[0] for call in calls])
                for row in rows:
                    self.assertEqual(digest(row["content"]), presentations[row["tool_call_id"]]["resultHash"])
                message, finish = dict(role="assistant", content="Synthetic complete."), "stop"
            return ChatCompletion.model_validate(dict(id="synthetic", object="chat.completion",
                created=1, model="deepseek-v4-pro", choices=[dict(index=0, finish_reason=finish, message=message)],
                usage=dict(prompt_tokens=10, completion_tokens=5, total_tokens=15)))
        client = types.SimpleNamespace(api_key="fixture", base_url="https://gary.invalid/v1",
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)), close=lambda: None)
        self.agent = self.session.create_agent(model="deepseek-v4-pro", client_factory=lambda *a, **kw: client,
            max_iterations=2, max_tokens=256)
        if configure:
            configure(self.agent)
        self.result = self.session.run_turn(self.agent, turn_id="presentation-turn", prompt="Synthetic bounded batch.")
        return [row for row in self.result["messages"] if row["role"] == "tool"]

    def test_real_native_warning_preserved_and_authenticated_after_raw_result(self):
        rows = self._batch([(str(i), "read_file", {"path": "missing.txt"}) for i in range(2)])
        self.assertIn("Tool loop warning", rows[1]["content"])
        frames = self.host.frames
        ends = [frame["payload"] for frame in frames if frame["kind"] == "tool.end"]
        presentations = [frame["payload"] for frame in frames if frame["kind"] == "tool.presentation"]
        self.assertEqual(len(ends), 2)
        self.assertEqual(ends[0]["resultHash"], presentations[0]["resultHash"])
        self.assertNotEqual(ends[1]["resultHash"], presentations[1]["resultHash"])
        self.assertEqual(presentations[1]["rawResultHash"], ends[1]["resultHash"])
        self.assertEqual(self.result["diagnostics"]["toolErrorDetails"][1]["resultHash"], ends[1]["resultHash"])
        self.assertLess(max(frame["sequence"] for frame in frames if frame["kind"] == "tool.end"),
                        min(frame["sequence"] for frame in frames if frame["kind"] == "tool.presentation"))

    def test_same_command_red_patch_green_keeps_original_distinct_call_ids(self):
        (self.host.workspace / "flag.txt").write_text("red\n")
        check = {"command": "test \"$(cat flag.txt)\" = green"}
        rows = self._batch([("red", "terminal", check), ("patch", "patch",
            {"path": "flag.txt", "old_string": "red", "new_string": "green"}), ("green", "terminal", check)])
        self.assertEqual(json.loads(rows[0]["content"])["exit_code"], 1)
        self.assertEqual(json.loads(rows[2]["content"])["exit_code"], 0)
        self.assertEqual((self.host.workspace / "flag.txt").read_text(), "green\n")
        self.assertEqual(self.result["diagnostics"]["toolCalls"], 3)

    def test_real_native_per_result_truncation_is_authenticated(self):
        rows = self._batch([("large", "terminal", {"command": "awk 'BEGIN {for (i=0;i<12000;i++) printf \"x\"}'"})],
            lambda agent: setattr(agent.context_compressor, "context_length", 8000))
        self.assertIn("Truncated: tool response", rows[0]["content"])
        self.assertLess(len(rows[0]["content"]), 5000)
        raw = next(frame["payload"] for frame in self.host.frames if frame["kind"] == "tool.end")
        self.assertNotEqual(raw["resultHash"], digest(rows[0]["content"]))

    def test_real_native_aggregate_budget_presentation_comes_after_batch(self):
        for name in ("one.txt", "two.txt"):
            (self.host.workspace / name).write_text(("x" * 99 + "\n") * 110)
        rows = self._batch([(str(i), "read_file", {"path": name}) for i, name in enumerate(("one.txt", "two.txt"))],
            lambda agent: setattr(agent.context_compressor, "context_length", 8000))
        self.assertLess(sum(len(row["content"]) for row in rows), 16000)
        self.assertTrue(any("Truncated: tool response" in row["content"] for row in rows))

    def test_native_hard_stop_still_prevents_execution_with_admitted_block_result(self):
        from agent.tool_guardrails import ToolCallGuardrailConfig, ToolCallGuardrailController
        def configure(agent):
            agent._tool_guardrails = ToolCallGuardrailController(ToolCallGuardrailConfig(
                hard_stop_enabled=True, exact_failure_block_after=1))
        rows = self._batch([(str(i), "read_file", {"path": "missing.txt"}) for i in range(2)], configure)
        self.assertEqual(len(self.requests), 1)
        ends = [frame["payload"] for frame in self.host.frames if frame["kind"] == "tool.end"]
        self.assertEqual(len(ends), 2)
        self.assertTrue(ends[0]["operationReceipts"])
        self.assertEqual(ends[1]["operationReceipts"], [])
        self.assertIn("repeated_exact_failure_block", rows[1]["content"])
        presentations = [frame["payload"] for frame in self.host.frames if frame["kind"] == "tool.presentation"]
        self.assertEqual(len(presentations), 2)
        self.assertEqual(presentations[1]["rawResultHash"], ends[1]["resultHash"])
        self.assertTrue(self.agent._tool_guardrail_halt_decision.should_halt)

    def test_backend_root_fault_survives_native_error_conversion_and_batch_failure(self):
        # An incomplete poll is terminal, even if native terminal handling turns
        # the exception into a tool error and a later batch failure masks it.
        original = self.session.environment_rpc
        def broken(operation, arguments):
            response = original(operation, arguments)
            if operation == "poll":
                response["outputTruncated"] = True
            return response
        self.session.environment._rpc = broken
        try:
            self._batch([("fault", "terminal", {"command": "printf synthetic"})])
        except EngineeringFault:
            pass
        self.assertEqual(self.session._first_fault["causes"][0]["code"], "incomplete_process_output")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len(self.host.starts), 1)
        self.assertTrue(self.session.environment._fenced)

    def test_repeated_ids_fail_before_any_environment_operation(self):
        with self.assertRaisesRegex(EngineeringFault, "session_fenced"):
            self._batch([("same", "read_file", {"path": "one"}), ("same", "read_file", {"path": "two"})])
        self.assertEqual(self.host.starts, [])
        self.assertFalse(self.host.frames)

    def test_altered_native_history_fences_before_presentation_or_another_model_call(self):
        def configure(agent):
            execute = agent._execute_tool_calls_sequential
            def altered(message, messages, task_id, api_call_count):
                result = execute(message, messages, task_id, api_call_count)
                messages[0]["content"] = "Altered synthetic original prompt"
                return result
            agent._execute_tool_calls_sequential = altered
        with self.assertRaisesRegex(EngineeringFault, "session_fenced"):
            self._batch([("original", "read_file", {"path": "missing"})], configure)
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(any(frame["kind"] == "tool.end" for frame in self.host.frames))
        self.assertFalse(any(frame["kind"] == "tool.presentation" for frame in self.host.frames))

    def test_reordered_native_results_fence_before_presentation(self):
        def configure(agent):
            execute = agent._execute_tool_calls_sequential
            def reordered(message, messages, task_id, api_call_count):
                result = execute(message, messages, task_id, api_call_count)
                messages[-2:] = messages[-2:][::-1]
                return result
            agent._execute_tool_calls_sequential = reordered
        with self.assertRaisesRegex(EngineeringFault, "session_fenced"):
            self._batch([("first", "read_file", {"path": "one"}), ("second", "read_file", {"path": "two"})], configure)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(len([frame for frame in self.host.frames if frame["kind"] == "tool.end"]), 2)
        self.assertFalse(any(frame["kind"] == "tool.presentation" for frame in self.host.frames))

    def test_native_system_bookkeeping_does_not_shift_presented_result_slice(self):
        def configure(agent):
            execute = agent._execute_tool_calls
            def with_system(message, messages, task_id, api_call_count=0):
                messages.insert(0, {"role": "system", "content": "Synthetic native bookkeeping"})
                return execute(message, messages, task_id, api_call_count)
            agent._execute_tool_calls = with_system
        rows = self._batch([("read", "read_file", {"path": "missing"})], configure)
        self.assertEqual(len(rows), 1)
        self.assertFalse(any(row["role"] == "system" for row in self.result["messages"]))
        self.assertEqual(len([frame for frame in self.host.frames if frame["kind"] == "tool.presentation"]), 1)


class PresentationModeTests(unittest.TestCase):
    def test_native_history_preserves_previous_system_filtering(self):
        self.assertEqual(native_history([{"role": "system", "content": "native"},
            {"role": "user", "content": "original"}]), [{"role": "user", "content": "original"}])

    def test_unknown_mode_is_rejected(self):
        for mode in (None, "", "Native_batch", True):
            with self.assertRaisesRegex(EngineeringFault, "invalid_result_presentation"):
                EngineeringSession(binding(), None, result_presentation=mode)


def load_tests(loader, tests, pattern):
    names = [name for name in NativePresentationTests.__dict__ if name.startswith("test_")]
    return unittest.TestSuite([*(NativePresentationTests(name) for name in names),
        loader.loadTestsFromTestCase(PresentationModeTests)])


if __name__ == "__main__":
    unittest.main()
