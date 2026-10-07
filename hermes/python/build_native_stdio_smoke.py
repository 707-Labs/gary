"""Bundle only adapter, fixture, tool schemas and public pinned-source metadata."""
import base64
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
files = {str(path.relative_to(root)): base64.b64encode(path.read_bytes()).decode() for path in [
    root / "python/gary_runtime.py", root / "python/native_stdio_smoke.py",
    root / "python/native-smoke-tools.json", root / "SOURCE.json"]}
outer = '''import base64,json,os,subprocess,sys,tarfile,tempfile
from pathlib import Path
os.umask(0o077)
files=json.loads(base64.b64decode("__FILES__"))
with tempfile.TemporaryDirectory(prefix="gary-hermes-native-stdio-fixture-") as directory:
 root=Path(directory);source=root/'vendor/hermes';source.mkdir(parents=True)
 archive=subprocess.Popen(['git','-C','/home/hermes/.hermes/hermes-agent','archive','9664e386f67965ec8bec5cf3db9d411f2c2b6cc0'],stdout=subprocess.PIPE)
 with tarfile.open(fileobj=archive.stdout,mode='r|') as tar:tar.extractall(source,filter='data')
 if archive.wait()!=0:raise RuntimeError('source archive failed')
 for relative,encoded in files.items():
  target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(base64.b64decode(encoded))
 (root/'empty-home').mkdir()
 env={'PATH':'/usr/bin:/bin','HOME':str(root/'empty-home'),'LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1'}
 result=subprocess.run([sys.executable,'-I',str(root/'python/native_stdio_smoke.py')],cwd=root,env=env,text=True,capture_output=True,timeout=100)
 print(result.stdout,end='')
 if result.returncode:
  print(json.dumps({'passed':False,'childExit':result.returncode,'stderr':result.stderr[-8000:]}))
  raise SystemExit(1)
'''.replace("__FILES__", base64.b64encode(json.dumps(files).encode()).decode())
(root / "python/run_native_stdio_smoke_remote.py").write_text(outer)
