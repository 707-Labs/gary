"""Native iteration/output propagation; fake provider, no paid-policy authority."""
import copy
import json
import shlex
import sys
import types
import unittest

from test_gary_engineering_runtime import NativeHandlerTests


class NativeIterationPolicyTests(NativeHandlerTests):
    def setUp(self):
        super().setUp()
        self.session.result_presentation = "native_batch"

    def _agent(self, response):
        from openai.types.chat import ChatCompletion
        self.requests = []
        def create(**kwargs):
            self.requests.append(copy.deepcopy(kwargs))
            number = len(self.requests)
            self.assertLessEqual(number, 12, "no thirteenth work or unaccounted summary request")
            self.assertEqual(kwargs["max_tokens"], 8192)
            self.assertEqual(kwargs["temperature"], 0.3)
            self.assertFalse(kwargs["stream"])
            name, args = response(number)
            message = {"role": "assistant", "content": None if name else "Synthetic project corrected and checked."}
            if name:
                call_id = "iteration-" + str(number)
                self.host.observe(call_id, name, args)
                message["tool_calls"] = [{"id": call_id, "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)}}]
            return ChatCompletion.model_validate({"id": "synthetic-" + str(number),
                "object": "chat.completion", "created": 1, "model": "deepseek-v4-pro",
                "choices": [{"index": 0, "finish_reason": "tool_calls" if name else "stop", "message": message}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        client = types.SimpleNamespace(api_key="fixture", base_url="https://gary.invalid/v1",
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)), close=lambda: None)
        return self.session.create_agent(model="deepseek-v4-pro", client_factory=lambda *a, **kw: client,
            max_iterations=12, max_tokens=8192)

    def test_eight_native_requests_inspect_write_red_patch_green_and_finish(self):
        (self.host.workspace / "CLAUDE.md").write_text("Synthetic project: fix only hostname.py and its regression test. Run the test before and after editing.\n")
        (self.host.workspace / "hostname.py").write_text('def allowed(host):\n    return host.endswith("example.org")\n')
        check = {"command": shlex.quote(sys.executable) + " test_hostname.py"}
        plan = [
            ("read_file", {"path": "CLAUDE.md"}),
            ("read_file", {"path": "hostname.py"}),
            ("read_file", {"path": "test_hostname.py"}),
            ("write_file", {"path": "test_hostname.py", "content":
                'from hostname import allowed\nassert allowed("example.org")\nassert allowed("sub.example.org")\nassert not allowed("evilexample.org")\n'}),
            ("terminal", check),
            ("patch", {"path": "hostname.py", "old_string": 'host.endswith("example.org")',
                "new_string": 'host == "example.org" or host.endswith(".example.org")'}),
            ("terminal", check),
            (None, None),
        ]
        agent = self._agent(lambda number: plan[number - 1])
        result = self.session.run_turn(agent, turn_id="eight-request-success", prompt="Correct the synthetic hostname boundary and prove the regression.")
        self.assertEqual(len(self.requests), 8)
        self.assertTrue(result["completed"])
        self.assertEqual(result["diagnostics"]["outcome"], "completed")
        self.assertEqual(result["diagnostics"]["modelRequests"], 8)
        self.assertEqual(result["diagnostics"]["toolCalls"], 7)
        self.assertEqual(result["diagnostics"]["toolResultErrors"], 1)
        rows = {row["tool_call_id"]: row["content"] for row in result["messages"] if row["role"] == "tool"}
        self.assertEqual(json.loads(rows["iteration-5"])["exit_code"], 1)
        self.assertEqual(json.loads(rows["iteration-7"])["exit_code"], 0)
        self.assertEqual((self.host.workspace / "hostname.py").read_text(),
            'def allowed(host):\n    return host == "example.org" or host.endswith(".example.org")\n')
        self.assertEqual(len([frame for frame in self.host.frames if frame["kind"] == "tool.presentation"]), 7)

    def test_twelve_request_cap_halts_without_a_thirteenth_summary_or_retry(self):
        agent = self._agent(lambda number: ("terminal", {"command": "printf 'synthetic-step-%d\\n'" % number}))
        result = self.session.run_turn(agent, turn_id="twelve-request-limit", prompt="Exercise only the synthetic request ceiling.")
        self.assertEqual(len(self.requests), 12)
        self.assertFalse(result["completed"])
        self.assertEqual(result["diagnostics"]["outcome"], "iteration_limit")
        self.assertEqual(result["diagnostics"]["modelRequests"], 12)
        self.assertEqual(result["diagnostics"]["toolCalls"], 12)
        # Native may return a UI-only exhaustion notice; it must not invent a
        # host-unobserved final assistant row or spend a summary request.
        self.assertTrue(all(row.get("tool_calls") for row in result["messages"] if row["role"] == "assistant"))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(NativeIterationPolicyTests(name) for name in NativeIterationPolicyTests.__dict__
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main()
