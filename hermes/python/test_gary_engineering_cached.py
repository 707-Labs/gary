"""Offline bootstrap for the already cached local native fixture dependencies.

No install, download, Docker, provider or live state. Run with Python 3.13.
Worker-image parity must still be checked by the parent-owned supervisor.
"""
from pathlib import Path
import os
import sys

root=Path('/Users/tanner/.cache/uv/archive-v0')
selected=('e_D1-cVKY6u7GOSFndb-I','XJuuSjHmr0MFJ60x_otSJ','4jX1LNxM_1dzJl5hSnBIS','12pnFZEDWUgaV78Koh4hl','WDq6vIrJjtoRihSsXeD1A','8S76TU8Fa8zu47tlelQGd','Bhe5uVig9aN2iakliAqjl','s5cyVxUUP1PfSU1I_2G6c','2fUN_QzoscWKvOF_Xyazq','mzIuQnJkcheTkd5flw4Wh','5CawYerEm8kt3nQ0xFP3u','IYPYavFwiVNx_m0kUlQEc','8lCUFG47kyIG7pJg143ap','GfFeV__vDw-rdastNGvqD','2Moy2qxie_YlV-ryPW-7N','sXY9J4f8NoaFPO448rgcX','HIL85Ic1Fz3JFOz22MRPI','hqK9XfGLTWOZPPDg4w8v7','_p7OmjdbiM1CQv2AZ2Fjl','_Jvtv7amwwXEGZ6xIHEDW','AYaw3mCv1M1CymVrV7CXg','NfSzJXkFKn5XcB7-6IARk','Tuj-M9oHnZh6io3KVH98J','87DO_4gs9JjDNTOmYF2xV','2bqXzL-WTmHEPJjcQl7FO','1rzG0BI9KyiOf8q9dV3Lc','8Po9Zlosk-gEDVlC-JbZz','KXnyr61G0asydPqL5PXz-','MRvzBC_FRFK9HKydde7fy','GAVdN6Sn28FMp6WXlK9zH','3_zTBlYrApwwy5XP-wF5o','aUXl4iic-K_9jeLidSllk','pWzh8e1ZbKAdDBW5jubT6','JDfy63prBXgp-wOwA1Gqg')
sys.path.extend(str(root/p) for p in selected)

sys.path.insert(0, str(Path(__file__).resolve().parent))
if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"
    if mode == "worker":
        import socket
        def denied(*args, **kwargs):
            raise RuntimeError("offline_fixture_network_forbidden")
        socket.socket.connect = denied
        from gary_engineering_runtime import main
        raise SystemExit(main())
    if mode == "schemas":
        import tempfile, json, time, contextlib
        from gary_engineering_runtime import EngineeringSession, scoped_home, load_native_source
        root_path = Path(__file__).resolve().parents[2]
        source = os.environ["GARY_NATIVE_SOURCE"]
        with tempfile.TemporaryDirectory(dir=root_path) as temporary:
            with scoped_home(Path(temporary).resolve(), restore=True):
                load_native_source(source)
                session = EngineeringSession({"taskId":"schema-task","sessionId":"schema-session",
                    "ownerEpoch":"schema-owner","deadlineMs":int(time.time()*1000)+60000}, None)
                with session.native_profile():
                    schemas = session.tool_schemas()
            (root_path / "hermes" / "engineering-tools.json").write_text(json.dumps(schemas, indent=2) + "\n")
        raise SystemExit(0)
    import unittest
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromName("test_gary_engineering_runtime"))
    raise SystemExit(not result.wasSuccessful())
