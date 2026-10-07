"""Run containment/cleanup probes with the exact exported TypeScript launch spec.

No model, executor, remote host, credential, workspace bind or listener is used.
Each probe replaces only the worker's Python script argument with literal test
code; all isolation flags, clean environment and immutable image stay unchanged.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--spec', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
spec = json.loads(Path(args.spec).read_text())
env, command = spec['env'], spec['command']
docker = command[0]
image = command[command.index('--entrypoint') + 2]
assert image.startswith('sha256:') and '--mount' not in command and '--volume' not in command
probe = r'''
import errno,json,os,socket,subprocess
from pathlib import Path
assert os.getuid()==65532 and os.getgid()==65532
assert set(os.environ)<= {'PATH','HOME','LC_CTYPE'} and os.environ['HOME']=='/tmp'
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert int(status['CapEff'].strip(),16)==0 and status['NoNewPrivs'].strip()=='1' and status['Seccomp'].strip()=='2'
denied={}
for name in ['/opt/gary-hermes-runtime/python/gary_runtime.py','/etc/gary-probe','/workspace/gary-probe']:
 try:
  with open(name,'ab') as f:f.write(b'forbidden')
 except OSError as error:denied[name]=error.errno
 else:raise AssertionError('write escaped readonly scope')
assert denied['/opt/gary-hermes-runtime/python/gary_runtime.py'] in (errno.EROFS,errno.EACCES)
assert denied['/etc/gary-probe'] in (errno.EROFS,errno.EACCES)
for name in ['/var/run/docker.sock','/Users/tanner','/workspace','/root/.ssh','/root/.aws']:
 try: exists=Path(name).exists()
 except PermissionError:exists=False
 assert not exists,name
assert not Path('/tmp/gary-ephemeral').exists()
Path('/tmp/gary-ephemeral').write_text('disposable')
Path('/tmp/noexec-probe').write_text('#!/bin/sh\nexit 0\n')
Path('/tmp/noexec-probe').chmod(0o700)
try:subprocess.run(['/tmp/noexec-probe'],check=True)
except OSError as error:assert error.errno==errno.EACCES
else:raise AssertionError('tmpfs unexpectedly executable')
sock=socket.socket();sock.settimeout(1)
try:sock.connect(('1.1.1.1',443))
except OSError as error:network_error=error.errno;assert error.errno==errno.ENETUNREACH
else:raise AssertionError('network escaped')
finally:sock.close()
print(json.dumps({'uid':os.getuid(),'capEff':0,'noNewPrivileges':True,'seccomp':2,'rootWriteErrors':denied,'tmpWritable':True,'tmpNoexec':True,'egressError':network_error,'hostPathsAbsent':True,'envKeys':sorted(os.environ)}),flush=True)
input()
'''
def run_probe(code, interrupted=False):
    name = 'gary-hermes-worker-' + str(uuid.uuid4())
    argv = list(command)
    argv[argv.index('--name') + 1] = name
    index = argv.index('python/gary_runtime.py')
    argv[index:] = ['-c', code]
    cleanup = [docker, 'container', 'rm', '--force', name]
    child = subprocess.Popen(argv, cwd=spec['cwd'], env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(timeout=15), 'container probe did not start'
        line = child.stdout.readline()
        if not line: raise AssertionError(child.stderr.read(8192).decode())
        result = json.loads(line)
        info = json.loads(subprocess.check_output([docker, 'container', 'inspect', name], env=env))[0]
        host = info['HostConfig']
        assert host['NetworkMode'] == 'none' and host['ReadonlyRootfs'] is True
        assert not host.get('Binds') and not host.get('Mounts') and not info.get('Mounts')
        assert host['PidsLimit'] == 128 and host['Memory'] == host['MemorySwap'] == 4294967296
        assert host['NanoCpus'] == 2000000000 and host['CapDrop'] == ['ALL']
        assert host['SecurityOpt'] == ['no-new-privileges=true']
        assert set(host['Tmpfs']) == {'/tmp'} and host['LogConfig']['Type'] == 'none'
        if interrupted:
            child.terminate()
            subprocess.run(cleanup, env=env, capture_output=True)
        else:
            child.stdin.write(b'\n'); child.stdin.flush()
        stdout, stderr = child.communicate(timeout=10)
        assert not stdout.strip() and not stderr.strip(), (stdout, stderr)
        if not interrupted:assert child.returncode == 0
        result.update(containerName=name, cleanupAfterInterrupt=interrupted, childExit=child.returncode)
        return result
    finally:
        # Exact unique name only; rm is idempotent after --rm already removed it.
        subprocess.run(cleanup, env=env, capture_output=True, timeout=10)
        if child.poll() is None:child.kill();child.wait(timeout=5)
        listing=subprocess.run([docker,'container','ls','--all','--filter','name=^'+name+'$','--format','{{.ID}}'],env=env,capture_output=True,check=True)
        assert not listing.stdout.strip()

results = [run_probe(probe), run_probe(probe), run_probe("import json;print(json.dumps({'ready':True}),flush=True);input()", True)]
report = {'passed': True, 'imageDigest': image, 'freshTmpfsOnSecondRun': True,
          'allContainersAbsentAfterCleanup': True, 'realProviderCalls': 0, 'scenarios': results}
Path(args.output).write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
print(json.dumps(report, sort_keys=True))
