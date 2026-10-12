"""Offline owned-pump lifecycle regressions; no Docker, provider or Slack calls."""
import os
import sys
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, os.environ['GARY_NATIVE_SOURCE'])
from gary_engineering_environment import GaryEnvironment, GaryProcessHandle, EnvironmentFault
from gary_engineering_runtime import EngineeringSession, worker_fault


class LifecycleTests(unittest.TestCase):
    def environment(self, rpc):
        # BaseEnvironment's initialization snapshot is unrelated to these unit tests.
        with patch.object(GaryEnvironment, 'init_session', lambda self: None):
            return GaryEnvironment(rpc)

    def test_running_command_close_quiesces_owned_pump_without_secondary_fault(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def rpc(op, args):
            calls.append(op)
            if op == 'poll':
                entered.set()
                self.assertTrue(release.wait(2))
                return dict(ok=True, receiptId='poll-receipt', processId='owned',
                            status='running', output='', outputTruncated=False)
            self.assertEqual(op, 'close')
            release.set()
            return dict(ok=True, receiptId='close-receipt', cleanupConfirmed=True)
        env = self.environment(rpc)
        observed = []
        env._fault_observer = observed.append
        handle = GaryProcessHandle(env, 'owned', 10)
        self.assertTrue(entered.wait(1))
        env.cleanup()
        self.assertFalse(handle._thread.is_alive())
        self.assertEqual(handle.wait(1), -15)
        self.assertEqual(observed, [])
        self.assertEqual(calls, ['poll', 'close'])
        self.assertEqual(env._first_transition['reason'], 'environment_close')
        with self.assertRaisesRegex(EnvironmentFault, '^environment_closed$'):
            env._operation('poll', {})
        handle.stdout.close()

    def test_cancel_stops_owned_pump_without_fabricating_a_backend_fault(self):
        polled = threading.Event()
        def rpc(op, args):
            if op == 'poll':
                polled.set()
                return dict(ok=True, receiptId='poll', processId='owned', status='running', output='', outputTruncated=False)
            return dict(ok=True, receiptId='cancel', cleanupConfirmed=True)
        env = self.environment(rpc)
        observed = []
        env._fault_observer = observed.append
        handle = GaryProcessHandle(env, 'owned', 10)
        self.assertTrue(polled.wait(1))
        session = object.__new__(EngineeringSession)
        session._fault_lock = threading.Lock()
        session._first_fault = None
        session._fenced = False
        session._closed = False
        env._fence_observer = session._fence_from_environment
        handle.kill()
        self.assertTrue(session._fenced)
        with self.assertRaisesRegex(Exception, '^session_fenced$'):
            session._guard()
        self.assertIsNone(session._first_fault)
        self.assertEqual(handle.wait(1), -15)
        self.assertEqual(observed, [])
        self.assertTrue(env._fenced)
        self.assertEqual(env._first_transition['reason'], 'process_cancel')
        handle.stdout.close()

    def test_poll_failure_is_recorded_before_cleanup_failure(self):
        original = EnvironmentFault('process_identity_mismatch')
        def rpc(op, args):
            if op == 'poll':
                raise original
            raise RuntimeError('secret cleanup message')
        env = self.environment(rpc)
        observed = []
        env._fault_observer = observed.append
        handle = GaryProcessHandle(env, 'owned', 10)
        self.assertTrue(handle._done.wait(1))
        self.assertIs(env._first_error, original)
        self.assertEqual(observed, [original])
        self.assertEqual(env._first_transition['initiator'], 'operation')
        with self.assertRaises(EnvironmentFault) as raised:
            handle.poll()
        self.assertIs(raised.exception.__cause__, original)
        self.assertEqual(worker_fault(original)['causes'][0]['code'], 'process_identity_mismatch')
        session = object.__new__(EngineeringSession)
        session._fault_lock = threading.Lock()
        session._first_fault = None
        session.environment = env
        diagnostic = session.failure_diagnostic(EnvironmentFault('environment_fenced'))
        self.assertEqual(diagnostic['causes'][0]['code'], 'process_identity_mismatch')
        handle.stdout.close()

    def test_deadline_fault_precedes_cancel_and_secondary_fenced_poll(self):
        def rpc(op, args):
            self.assertEqual(op, 'cancel')
            return dict(ok=True, receiptId='cancel-receipt', cleanupConfirmed=True)
        env = self.environment(rpc)
        observed = []
        env._fault_observer = observed.append
        # Deterministically run the pump after its deadline without another thread.
        with patch.object(threading.Thread, 'start', lambda self: None):
            handle = GaryProcessHandle(env, 'owned', 10)
        handle._deadline = 0
        handle._pump()
        self.assertEqual(str(env._first_error), 'process_deadline_exceeded')
        self.assertEqual(len(observed), 1)
        self.assertEqual(env._first_transition['reason'], 'backend_fault')
        with self.assertRaisesRegex(EnvironmentFault, '^environment_fenced$'):
            env._operation('poll', {})
        handle.stdout.close()

    def test_runtime_first_exception_survives_later_poll_fault(self):
        session = object.__new__(EngineeringSession)
        session._first_fault = None
        session._fault_lock = threading.Lock()
        session._fenced = False
        session._record_backend_fault(EnvironmentFault('process_deadline_exceeded'))
        session._record_backend_fault(EnvironmentFault('environment_fenced'))
        self.assertEqual(session._first_fault['causes'][0]['code'], 'process_deadline_exceeded')
        self.assertTrue(session._fenced)

    def test_closed_poll_diagnostic_retains_first_close_and_original_exception(self):
        env = self.environment(lambda op, args: dict(ok=True, receiptId='close', cleanupConfirmed=True))
        env.cleanup()
        session = object.__new__(EngineeringSession)
        session._first_fault = None
        session._fault_lock = threading.Lock()
        session.environment = env
        session._record_backend_fault(EnvironmentFault('process_identity_mismatch'))
        diagnostic = session.failure_diagnostic(EnvironmentFault('environment_closed'))
        self.assertEqual(diagnostic['causes'][0]['code'], 'process_identity_mismatch')
        self.assertEqual(diagnostic['lifecycle']['reason'], 'environment_close')
        self.assertEqual(diagnostic['lifecycle']['state'], 'closing')
        self.assertGreater(diagnostic['lifecycle']['atMs'], 0)
        self.assertNotIn('command', diagnostic['lifecycle'])

    def test_unquiesced_owned_pump_fails_closed_without_hiding_close_error(self):
        class StuckThread:
            def join(self, timeout):
                self.timeout = timeout
            def is_alive(self):
                return True
        from types import SimpleNamespace
        for close_error in (None, RuntimeError('private close failure')):
            def rpc(op, args):
                if close_error is not None:
                    raise close_error
                return dict(ok=True, receiptId='close', cleanupConfirmed=True)
            env = self.environment(rpc)
            handle = SimpleNamespace(_stop=threading.Event(), _thread=StuckThread())
            # Adapter-owned registry normally contains GaryProcessHandle instances.
            env._handles = [handle]
            with self.assertRaises(Exception) as raised:
                env.cleanup()
            self.assertTrue(handle._stop.is_set())
            self.assertLessEqual(handle._thread.timeout, 2)
            self.assertTrue(env._fenced)
            if close_error is not None:
                self.assertIs(raised.exception, close_error)
                self.assertIs(env._first_error, close_error)
            else:
                self.assertEqual(str(raised.exception), 'polling_cleanup_unconfirmed')

    def test_close_failure_is_preserved_and_does_not_claim_closed(self):
        original = RuntimeError('private transport details')
        def rpc(op, args):
            raise original
        env = self.environment(rpc)
        with self.assertRaises(RuntimeError):
            env.cleanup()
        self.assertIs(env._first_error, original)
        self.assertFalse(env._closed)
        self.assertTrue(env._fenced)
        self.assertEqual(env._first_transition['state'], 'closing')
        self.assertEqual(worker_fault(original)['causes'][0]['code'], 'unknown_failure')

if __name__ == '__main__':
    unittest.main()
