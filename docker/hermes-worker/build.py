"""Explicit local build only; never launches a worker or activates a service.

Pass a separately reviewed wrapper hash. Build context contains this directory's
fixed build files, the pinned public archive and frozen wrapper/metadata bytes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--wrapper', required=True)
parser.add_argument('--source-metadata', required=True)
parser.add_argument('--expected-wrapper-sha256', required=True)
parser.add_argument('--docker-host', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
assert re.fullmatch(r'[a-f0-9]{64}', args.expected_wrapper_sha256)
assert re.fullmatch(r'unix://(/[A-Za-z0-9_.-]+)+\.sock', args.docker_host)
assert not any(x in ('.', '..') for x in args.docker_host[7:].split('/'))
source = Path(__file__).resolve().parent
docker = '/usr/local/bin/docker'
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'DOCKER_HOST': args.docker_host,
       'DOCKER_CONFIG': '/var/empty/gary-hermes-no-docker-config'}
archive = Path(args.archive).read_bytes()
wrapper = Path(args.wrapper).read_bytes()
metadata = Path(args.source_metadata).read_bytes()
assert hashlib.sha256(archive).hexdigest() == '9551e0c2ea7c6feaea6d03362fb1344af7742bfb4980397bcfecffcdf2f427fb'
assert hashlib.sha256(wrapper).hexdigest() == args.expected_wrapper_sha256
assert json.loads(metadata)['hermes_revision'] == '9664e386f67965ec8bec5cf3db9d411f2c2b6cc0'
with tempfile.TemporaryDirectory(prefix='gary-hermes-image-') as directory:
    context = Path(directory)
    for name in ('Dockerfile', 'requirements-linux-arm64.txt', 'dependency-lock.json', 'extract-source.py', 'attest-image.py'):
        shutil.copyfile(source / name, context / name)
    (context / 'hermes-source.tar').write_bytes(archive)
    (context / 'gary_runtime.py').write_bytes(wrapper)
    (context / 'SOURCE.json').write_bytes(metadata)
    common = [docker, 'build', '--platform', 'linux/arm64']
    subprocess.run(common + ['--network', 'default', '--target', 'dependencies', str(context)], env=env, check=True)
    iid = context / 'image-id'
    subprocess.run(common + ['--network', 'none', '--target', 'worker', '--iidfile', str(iid), str(context)], env=env, check=True)
    image = iid.read_text().strip()
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', image)
    info = json.loads(subprocess.check_output([docker, 'image', 'inspect', image], env=env))[0]
    assert info['Os'] == 'linux' and info['Architecture'] == 'arm64'
    assert not info['Config'].get('Volumes') and not info['Config'].get('Healthcheck')
    assert info['Config']['User'] == '65532:65532'
    report = {'imageDigest': image, 'architecture': 'linux/arm64', 'activation': 'disabled',
              'baseImage': 'python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89',
              'hermesRevision': '9664e386f67965ec8bec5cf3db9d411f2c2b6cc0',
              'archiveSha256': hashlib.sha256(archive).hexdigest(), 'wrapperSha256': args.expected_wrapper_sha256,
              'metadataSha256': hashlib.sha256(metadata).hexdigest(),
              'requirementsSha256': hashlib.sha256((source / 'requirements-linux-arm64.txt').read_bytes()).hexdigest(),
              'dependencyLockSha256': hashlib.sha256((source / 'dependency-lock.json').read_bytes()).hexdigest(),
              'dockerfileSha256': hashlib.sha256((source / 'Dockerfile').read_bytes()).hexdigest(),
              'networkScope': 'dependency pass: pinned HTTPS wheels on files.pythonhosted.org; final source/image pass: none',
              'hostMounts': [], 'buildSecrets': [], 'buildSSH': False, 'declaredVolumes': [], 'sizeBytes': info['Size']}
    Path(args.output).write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print(json.dumps(report, sort_keys=True))
