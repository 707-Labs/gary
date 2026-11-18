"""Offline-only bridge: exact production worker with cached SDK and denied sockets."""
import pathlib, sys, socket, json
sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "hermes/python"))
import test_gary_engineering_cached

def denied(*args, **kwargs):
    raise AssertionError("offline04_network_forbidden")

socket.socket.connect = denied
socket.socket.connect_ex = denied
socket.create_connection = denied
from gary_engineering_runtime import main, EngineeringStdio
capture = pathlib.Path(sys.argv[1])
assert capture.parent.resolve() == pathlib.Path.cwd().resolve()
original_write = EngineeringStdio.write
def recorded_write(self, frame):
    with capture.open("a") as output:
        output.write(json.dumps(frame, ensure_ascii=False) + "\n")
    return original_write(self, frame)
EngineeringStdio.write = recorded_write
raise SystemExit(main())
