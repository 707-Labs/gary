import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
import types
import unittest

# Import only the host adapter. No Hermes checkout, shell, provider or model.
base = types.ModuleType('tools.environments.base')
base.BaseEnvironment = type('BaseEnvironment', (), {})
sys.modules['tools.environments.base'] = base
spec = importlib.util.spec_from_file_location('polling_adapter', Path(__file__).resolve().parents[3] / 'hermes/python/gary_engineering_environment.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class Clock:
    def __init__(self): self.now = 0.0; self.waits = []
    def monotonic(self): return self.now
    def sleep(self, seconds): self.waits.append(seconds); self.now += seconds

class Event:
    def __init__(self, clock): self.clock = clock; self.done = False; self.on_wait = None
    def wait(self, timeout=None):
        if self.done: return True
        if self.on_wait: self.on_wait()
        if timeout is not None: self.clock.sleep(timeout)
        return self.done
    def set(self): self.done = True
    def is_set(self): return self.done

class Environment:
    def __init__(self, clock, duration, output=''):
        self.clock = clock; self.duration = duration; self.output = output
        self.max_output_bytes = 8 * 1024 * 1024; self._fenced = False
        self.operations = []; self.limit = 1000; self.bad = None
    def _operation(self, operation, arguments):
        if self._fenced and operation != 'cancel': raise adapter.EnvironmentFault('environment_fenced')
        if len(self.operations) >= self.limit: raise adapter.EnvironmentFault('operation_replay_or_limit')
        self.operations.append(operation)
        if operation == 'cancel': return {'cleanupConfirmed': True}
        result = {'processId': 'process', 'output': self.output, 'outputTruncated': False,
                  'status': 'exited' if self.clock.now >= self.duration else 'running', 'exitCode': 0}
        if self.bad: result.update(self.bad)
        return result

class PollingTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock(); self.old_time = adapter.time
        adapter.time = self.clock
        self.handles = []
    def tearDown(self):
        adapter.time = self.old_time
        for h in self.handles:
            if not h._done.is_set(): os.close(h._write_fd)
            h.stdout.close()
    def handle(self, duration=0, timeout=180, output=''):
        env = Environment(self.clock, duration, output)
        h = adapter.GaryProcessHandle.__new__(adapter.GaryProcessHandle)
        h.environment = env; h.process_id = 'process'; h._returncode = None; h._fault = None
        h._done = Event(self.clock); h._cancel_lock = threading.Lock(); h._cancelled = False
        fd, h._write_fd = os.pipe(); h._stdout = os.fdopen(fd, 'r', encoding='utf8')
        h._deadline = self.clock.now + timeout; self.handles.append(h)
        return h, env
    def test_quiet_long_command_completes_below_protocol_ceiling(self):
        h, env = self.handle(duration=120)
        h._pump()
        self.assertIsNone(h._fault); self.assertEqual(h.wait(0), 0)
        self.assertLess(len(env.operations), 70)
        self.assertLessEqual(max(self.clock.waits), 2.0)
    def test_streaming_output_is_incremental_and_polling_stays_bounded(self):
        h, env = self.handle(duration=60, output='line\n')
        h._pump()
        self.assertIsNone(h._fault); self.assertEqual(h.wait(0), 0)
        self.assertLessEqual(len(env.operations), 250)
        self.assertEqual(h.stdout.read().count('line\n'), len(env.operations))
    def test_fast_command_preserves_exit_code_and_output(self):
        h, env = self.handle(output='done\n'); h._pump()
        self.assertEqual(h.wait(0), 0); self.assertEqual(h.stdout.read(), 'done\n')
        self.assertEqual(env.operations, ['poll'])
    def test_deadline_wait_is_clipped_and_cancelled_once(self):
        h, env = self.handle(duration=100, timeout=1)
        h._pump()
        self.assertIsInstance(h._fault, adapter.EnvironmentFault)
        self.assertEqual(str(h._fault), 'process_deadline_exceeded')
        self.assertAlmostEqual(self.clock.now, 1.0)
        self.assertEqual(env.operations.count('cancel'), 1)
        self.assertTrue(env._fenced)
    def test_cancellation_does_not_restart_or_repeat_the_command(self):
        h, env = self.handle(duration=120)
        h._done.on_wait = h.kill; h._pump()
        self.assertEqual(env.operations, ['poll', 'cancel'])
        self.assertTrue(env._fenced); self.assertIsNotNone(h._fault)
    def test_wait_timeout_never_adds_an_rpc(self):
        h, env = self.handle()
        with self.assertRaises(subprocess.TimeoutExpired): h.wait(0)
        self.assertEqual(env.operations, [])
        h._pump(); self.assertEqual(h.wait(0), 0)
    def test_identity_and_output_faults_still_cancel_and_fence(self):
        for bad in [{'processId': 'foreign'}, {'outputTruncated': True}, {'exitCode': True}]:
            h, env = self.handle(); env.bad = bad; h._pump()
            self.assertIsNotNone(h._fault); self.assertTrue(env._fenced)
            self.assertEqual(env.operations.count('cancel'), 1)
    def test_existing_operation_ceiling_is_not_bypassed(self):
        h, env = self.handle(duration=120); env.operations = ['poll'] * 1000
        h._pump()
        self.assertEqual(str(h._fault), 'operation_replay_or_limit')
        self.assertEqual(len(env.operations), 1000); self.assertTrue(env._fenced)

if __name__ == '__main__': unittest.main()
