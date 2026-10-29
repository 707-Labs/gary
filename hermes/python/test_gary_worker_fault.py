import json
import unittest
from gary_engineering_runtime import EngineeringFault, worker_fault, main
import os,sys
sys.path.insert(0,os.environ["GARY_NATIVE_SOURCE"])
from gary_engineering_environment import EnvironmentFault

class WorkerFaultTests(unittest.TestCase):
    def test_unknown_messages_and_class_names_never_persist(self):
        error = RuntimeError('secret-token /private/path task prompt')
        wire = json.dumps(worker_fault(error))
        self.assertNotIn('secret-token',wire)
        self.assertNotIn('/private',wire)
        self.assertNotIn('RuntimeError',wire)
        self.assertIn('unknown_failure',wire)

    def test_bounded_root_cause_survives_masking(self):
        try:
            try:
                raise EnvironmentFault('process_deadline_exceeded')
            except EnvironmentFault as root:
                raise EnvironmentFault('process_observation_failed') from root
        except Exception as error:
            wire=worker_fault(error)
        self.assertEqual([c['code'] for c in wire['causes']],['process_observation_failed','process_deadline_exceeded'])
        self.assertTrue(all(len(c['frames'])<=4 for c in wire['causes']))

    def test_main_emits_exact_safe_envelope_for_original_error(self):
        import io
        output=io.StringIO()
        self.assertEqual(main(input_stream=io.StringIO('{"type":"secret-token"}\n'),output_stream=output),1)
        wire=json.loads(output.getvalue())
        self.assertEqual(set(wire),{'type','error','cleanupConfirmed','diagnostic'})
        self.assertEqual(wire['type'],'engineering.error')
        self.assertEqual(wire['diagnostic']['causes'][0]['code'],'invalid_engineering_start')
        self.assertNotIn('secret-token',output.getvalue())
