# Gary execution sandbox

Gary keeps scheduling, Linear/GitHub access, model calls, and credentials on the
host. Model-controlled file and shell tools run in a fresh container with only
the ticket worktree mounted. The container receives no host environment, API
keys, SSH agent, or Docker socket.

Build on the current host:

```sh
docker build -t gary-executor:ubuntu24.04 docker/executor
```

The image pins Bun 1.3.14 and Node 24.21.0. Node is copied from the official
`node:24.21.0-bookworm-slim` multi-architecture image at digest
`sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
The build executes both runtimes to check shared-library compatibility with
Ubuntu. Bun installs dependencies and launches package scripts; Node-shebang
tools such as Vitest run under Node. Do not force them onto Bun with `--bun`.

Run the sandbox and runtime integration checks against the newly built image:

```sh
GARY_DOCKER_TEST_IMAGE="$(docker image inspect --format '{{.Id}}' gary-executor:ubuntu24.04)" \
  bun test test/docker-executor.test.ts
```

After the integration smoke test passes, enable it in Gary's mode-0600
environment file:

```dotenv
GARY_EXECUTOR=docker
GARY_EXECUTOR_IMAGE=gary-executor:ubuntu24.04
GARY_EXECUTOR_NETWORK=none
GARY_BUN_CACHE_VOLUME=gary-bun-cache
GARY_EXECUTOR_MEMORY=12g
```

`none` is deliberate: model-controlled shell commands cannot scan the LAN or
tailnet. Gary's typed Linear, GitHub, and read-only observability adapters stay
outside the container. Warm the credential-free Linux package cache from an
operator-reviewed lockfile, then Gary mounts that Docker volume read-only:

```sh
# Review package.json and bun.lock at this exact commit before running.
reviewed_commit="$(git -C /absolute/project/repository rev-parse HEAD)"
GARY_BUN_CACHE_VOLUME=gary-bun-cache-candidate \
  docker/executor/warm-bun-cache.sh /absolute/project/repository "$reviewed_commit"
```

The helper requires an explicit reviewed Git commit. It streams only that
commit's `package.json` and `bun.lock` into a temporary container; uncommitted
worktree changes and other repository files are never mounted. The local
executor image is resolved to its immutable image ID before warm-up. The
output records that ID, the source commit, both manifest SHA-256 hashes, and
runtime versions. The frozen install disables package lifecycle scripts and
has network only for the duration of this explicit operator action.

Use a fresh cache volume for each candidate deployment and keep the preceding
image ID and cache volume for rollback. Only select the new volume in Gary's
environment after frozen offline installation and the relevant repository
tests succeed in a disposable snapshot of the same commit, through the normal
`DockerExecutor` with `networkMode: "none"`. Gary mounts the selected cache
read-only. For ERT-3189, the readiness commands inside that executor are:

```sh
bun install --offline --ignore-scripts --frozen-lockfile
bun run test:run tests/dev-prod-party.test.ts --project=src-node
bun run check
```

Generate `.svelte-kit` metadata using the repository's normal tooling if its
check command requires it. The offline baseline must actually run and pass;
a successful networked warm-up alone is not readiness evidence. Packages
absent from the cache must be admitted by an operator before the run;
do not switch to `bridge` until the Docker host has an egress policy that blocks
private, link-local, metadata, and tailnet ranges.

## Move to an Ubuntu 24.04 Intel NUC

1. Install Ubuntu Server 24.04 LTS and Docker Engine from Docker's apt repo.
2. Create a locked, non-sudo `gary` service user and add only that user to the
   Docker group. Do not expose the Docker API over TCP.
3. Clone this repository and build the same image command above. The pinned
   multi-architecture base images select `linux/amd64` automatically.
4. Stop Gary on the old host before copying `~/.gary/state/gary.db`; never run
   two schedulers. Bare clones and worktrees may be rebuilt instead of copied.
5. Put provider, Linear, and GitHub credentials in a mode-0600 systemd
   `EnvironmentFile`; keep them out of the image and worktree.
6. Start Gary with the three executor variables above and repeat the sandbox
   smoke test before enabling its timer/service.

The Docker socket remains host-side. The executor creates short-lived
containers rather than a privileged long-running worker, so the migration is a
host move, not a change to Gary's scheduling architecture.
