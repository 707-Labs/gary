# Immutable Hermes worker build and rehearsal

This directory builds a disposable Linux arm64 worker. It does not activate a
service, read a live ledger, call a provider, or modify credentials. The image
contains the frozen wrapper plus the complete pinned public Hermes archive.
There are no host source, workspace, credential or Docker socket mounts.

The recorded successful rehearsal uses:

- Image: `sha256:b52a41253812cc6d3054b84e6c59e6be5cf485a3cd955baf1085a4bb1bde9eab`
- Official Python 3.11.17 base:
  `python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89`
- Hermes revision: `9664e386f67965ec8bec5cf3db9d411f2c2b6cc0`
- Source archive SHA256: `9551e0c2ea7c6feaea6d03362fb1344af7742bfb4980397bcfecffcdf2f427fb`
- Wrapper SHA256: `f1629fa2fcea6ef584010550427c7bdd2af516a28599c173941a3106683739a2`
- Upstream uv.lock SHA256: `8fd868b9da8b6bc2f4aa94a845e210eccdd5e31be7a0b404f0a8527ced0fddec`
- Requirements SHA256: `a8dc5105379aa2fea04de2f4d64ffc899c90a4c7cb689228eb2d24379f257813`
- Baked wrapper/archive attestation:
  `sha256:32588b7d59c5914bd094ac9e9ace50b823898b6257f1dced5feaf96e5f09cf26`

`dependency-lock.json` lists every one of the 60 wheel versions, exact URLs and
hashes. `export-lock.py` generated those from the pinned upstream lock inside the
pinned official Python base with networking disabled. Only core dependencies
and their transitives were selected; no Hermes optional extras, source packages
or package build scripts were installed. `pip check` passed.

The dependency build pass permits Docker's default build network and downloads
only the listed HTTPS wheel URLs from `files.pythonhosted.org`. This is a
description of the build inputs, not a domain firewall claim. The source/final
image build pass runs with `--network none`. No build secrets, SSH forwarding,
host credentials or additional build software are used. The existing Colima
installation uses Docker's legacy builder, so two build passes enforce this
separation without installing BuildKit.

Run from the worktree root, supplying the independently reviewed wrapper hash:

```sh
python3 docker/hermes-worker/build.py \
  --archive /tmp/hermes-source-9664.tar \
  --wrapper hermes/python/gary_runtime.py \
  --source-metadata hermes/SOURCE.json \
  --expected-wrapper-sha256 f1629fa2fcea6ef584010550427c7bdd2af516a28599c173941a3106683739a2 \
  --docker-host unix:///Users/tanner/.colima/default/docker.sock \
  --output docker/hermes-worker/build-result.json
```

The image ID records immutable local content. Build timestamps may change its
ID on a fresh rebuild; use the newly reviewed ID, never a mutable tag. The build
driver copies only its explicit allowlist into a fresh temporary build context,
checks archive/wrapper hashes, then deletes that context. Docker retains the
result and ordinary build cache. Nothing is pushed to a registry.

`createDockerRuntimeLauncher` in `src/hermes/docker-launcher.ts` is the concrete
host factory. Supply the reviewed full image ID and explicit local Docker Unix
socket. Each call checks local image metadata, starts a fresh unique container
and awaits exact-name removal and successful absence verification. It uses an
explicit clean host CLI environment, and `/usr/bin/env -i` clears image ENV
before Python. Only PATH/HOME are supplied; Python adds LC_CTYPE internally.

Runtime controls: network none, root filesystem readonly, UID/GID 65532, all
capabilities dropped, no-new-privileges, Docker default seccomp, PID limit 128,
4 GiB memory/no swap increase, 2 CPUs, nofile 256, no healthcheck/log driver,
and a 256 MiB noexec/nosuid/nodev tmpfs at `/tmp`. The image declares no volumes.
The Docker socket is used by the trusted host CLI and is never mounted inside.

Rehearsal evidence:

- `native-stdio-result.json`: actual pinned Hermes + SDK with fake stdio broker;
  successful finish, denied model authority, strict two-request cap, and a fresh
  worker continuing canonical history with exact prior tool results preserved,
  including leading/trailing whitespace and newline-bearing receipts. Every SDK
  request and exported history matches the fixture transcript exactly. Nine fake
  model responses total; zero real provider/executor calls. These are standalone
  protocol fixtures; combined production-host evidence is recorded separately.
- `containment-result.json`: actual network ENETUNREACH, source/root writes
  denied, host paths unavailable, kernel UID/capabilities/no-new-privileges/
  seccomp, tmpfs noexec and fresh next run, and removal after normal/interrupted
  workers. `container-smoke.py` reproduces these probes using the exported spec.
- `image-source-attestation.json`: 9,645 files (9,644 archive regular files plus
  wrapper), with both case-distinct contributor filenames retained on Linux.
  It is review material, not self-approval. `SOURCE.json` alone is not proof.
- `build-result.json`: exact image, inputs, dependency manifest hashes and scope.

An image digest eliminates the mutable-host-source gap of the earlier bind
proposal. It does not make arbitrary supplied image contents trusted: the
operator must review the image and external expected digests. Runtime cleanup
is awaited for normal failures, cancellation and deadlines; abrupt loss of the
host process/daemon still needs recovery by the recorded exact container name.

The earlier image `sha256:7727d76c636cfca88392f02af99c9fceca4c9bb4ee5b4fc41a29d00390d73cdc`
passed its original standalone fixtures but failed combined host transcript
verification because native Hermes trimmed a tool-result trailing newline.
The replacement image above preserves the exact authenticated transcript.
Its strengthened standalone fixtures and containment probes passed; consult the
combined-host test evidence for the separate production integration result.
