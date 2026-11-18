"""Image-parity fixture entrypoint; run only via the parent-reviewed supervisor.

This file DOES NOT launch Docker, acquire a lock, or contact a provider. Required
supervisor conditions (not established by this script):
* canonical heavy lock remains held through exact worker removal verification;
* pinned daemon identity and existing image sha256:
  b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab;
* fail closed if ANY gary-hermes-worker container exists; never stop an existing
  worker; image reuse only, no pull/build, no Docker socket or credentials;
* --network none --read-only --cap-drop ALL --security-opt no-new-privileges,
  non-root, bounded CPU/RAM/PIDs/tmpfs, 60-second deadline, output <10 MiB;
* mount these reviewed four Python files read-only to /opt/gary-engineering:
  environment, runtime, test_runtime, and this image_fixture entrypoint;
* PYTHONDONTWRITEBYTECODE=1, PYTHONNOUSERSITE=1, synthetic home/tmpfs only;
* source /opt/gary-hermes-runtime/vendor/hermes, existing image dependencies.

Use the launcher's pinned image Python command with sys.path containing
/opt/gary-engineering and /opt/gary-hermes-runtime/python, then call main().
The fixture uses synthetic files and a fake provider. Its shell subprocesses
run inside the worker only. It verifies pinned native algorithms/dependency
parity, NOT confinement of the separate real DockerExecutor build session.
The TS launcher/protocol fixture independently covers host wire admissions.
"""
from pathlib import Path
import os
import socket
import sys
import tempfile
import unittest


def main():
    def denied(*args, **kwargs):
        raise RuntimeError("image_fixture_network_forbidden")
    socket.socket.connect = denied
    os.environ["GARY_NATIVE_SOURCE"] = "/opt/gary-hermes-runtime/vendor/hermes"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["PYTHONNOUSERSITE"] = "1"
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix="gary-native-fixture-", dir="/tmp") as directory:
        os.environ["GARY_FIXTURE_ROOT"] = str(Path(directory).resolve())
        result = unittest.TextTestRunner(verbosity=2).run(
            unittest.defaultTestLoader.loadTestsFromName("test_gary_engineering_runtime"))
        return 0 if result.wasSuccessful() and result.testsRun >= 13 and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
