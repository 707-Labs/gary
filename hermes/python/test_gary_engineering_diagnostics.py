"""Real native handler error attribution; synthetic files/provider, no network.
Run through test_gary_engineering_cached bootstrap with pinned GARY_NATIVE_SOURCE.
"""
import copy
import json
import types
import unittest

from gary_engineering_runtime import digest
from test_gary_engineering_runtime import NativeHandlerTests


class NativeDiagnosticTests(NativeHandlerTests):
    # Inherit only fixture setup/helpers, avoiding duplicate inherited test runs.
    def _run_errors(self, count, turn_id):
        from openai.types.chat import ChatCompletion
        requests = []
        host = self.host
        marker = 'synthetic-private-path-never-in-diagnostics'

        def create(**kwargs):
            requests.append(copy.deepcopy(kwargs))
            if len(requests) == 1:
                calls = []
                for number in range(count):
                    call_id = 'diagnostic-%s-%d' % (turn_id, number)
                    args = {'path': marker + '-%d.txt' % number}
                    host.observe(call_id, 'read_file', args)
                    calls.append({'id': call_id, 'type': 'function', 'function': {
                        'name': 'read_file', 'arguments': json.dumps(args)}})
                message = {'role': 'assistant', 'content': None, 'tool_calls': calls}
                finish = 'tool_calls'
            else:
                self.assertEqual(len(requests), 2, 'no extra request')
                message, finish = {'role': 'assistant', 'content': 'Synthetic error observation complete.'}, 'stop'
            return ChatCompletion.model_validate({'id': 'diagnostic-response-' + str(len(requests)),
                'object': 'chat.completion', 'created': 1, 'model': 'deepseek-v4-pro',
                'choices': [{'index': 0, 'finish_reason': finish, 'message': message}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        client = types.SimpleNamespace(api_key='fixture', base_url='https://gary.invalid/v1',
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)), close=lambda: None)
        agent = self.session.create_agent(model='deepseek-v4-pro', client_factory=lambda *a, **kw: client,
                                          max_iterations=2, max_tokens=256)
        result = self.session.run_turn(agent, turn_id=turn_id, prompt='Read the synthetic missing fixture files.')
        self.assertEqual(len(requests), 2)
        diagnostics = result['diagnostics']
        self.assertEqual(diagnostics['toolCalls'], count)
        self.assertEqual(diagnostics['toolResultErrors'], count)
        self.assertEqual(diagnostics['toolFailures'], 0)
        self.assertEqual(diagnostics['toolBlocks'], 0)
        self.assertNotIn(marker, json.dumps(diagnostics))
        self.assertNotIn('File not found', json.dumps(diagnostics))
        self.assertNotIn('/workspace', json.dumps(diagnostics))
        returned = [item for item in result['messages'] if item['role'] == 'tool']
        ends = [frame['payload'] for frame in host.frames if frame['kind'] == 'tool.end'
                and frame['payload']['toolCallId'].startswith('diagnostic-' + turn_id)]
        self.assertEqual(len(returned), count)
        for i, detail in enumerate(diagnostics['toolErrorDetails']):
            self.assertEqual(set(detail), {'toolOrdinal', 'toolName', 'phase', 'category', 'resultHash'})
            self.assertEqual(detail, {'toolOrdinal': i + 1, 'toolName': 'read_file', 'phase': 'native_result',
                'category': 'native_reported_error', 'resultHash': ends[i]['resultHash']})
            # Pinned AIAgent may enrich repeated errors in conversation
            # history. The authenticated tool.end hash binds the original
            # handler result; it need not hash the later enriched message.
            if count == 1:
                self.assertEqual(detail['resultHash'], digest(returned[i]['content']))
            native_error, _ = json.JSONDecoder().raw_decode(returned[i]['content'])
            self.assertTrue(native_error['error'])
        self.assertEqual(len(diagnostics['toolErrorDetails']), min(count, 6))
        self.assertEqual(diagnostics['toolErrorDetailsTruncated'], count > 6)
        # Parent durable diagnostics allow 2,048 bytes. The largest detail form
        # (longest approved tool name) still fits with the observed host counts.
        durable = {'version': 1, 'event': 'native_result', 'phase': 'native_turn', 'code': 'none',
            'workerReported': copy.deepcopy(diagnostics), 'hostObserved': {
                'environmentOperations': 2048, 'modelRequestsReceived': 2048,
                'toolBegins': 2048, 'toolEnds': 2048, 'toolFailures': 2048}}
        for detail in durable['workerReported']['toolErrorDetails']:
            detail.update(toolName='session_search', toolOrdinal=2048)
        self.assertLessEqual(len(json.dumps(durable, separators=(',', ':')).encode()), 2048)
        return diagnostics

    def test_real_native_missing_read_preserves_error_attribution_without_body(self):
        self._run_errors(1, 'diagnostic-one')

    def test_real_native_error_overflow_retains_first_six_exact_hashes(self):
        self._run_errors(7, 'diagnostic-overflow')

    def test_details_reset_between_turns(self):
        self._run_errors(7, 'diagnostic-before-reset')
        self._run_errors(1, 'diagnostic-after-reset')


# Explicit suite: base class contains separate existing native tests.
def load_tests(loader, tests, pattern):
    names = ('test_real_native_missing_read_preserves_error_attribution_without_body',
             'test_real_native_error_overflow_retains_first_six_exact_hashes',
             'test_details_reset_between_turns')
    return unittest.TestSuite(NativeDiagnosticTests(name) for name in names)

if __name__ == '__main__':
    unittest.main()
