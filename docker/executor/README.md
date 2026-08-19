# Gary execution sandbox

Gary keeps scheduling, Linear/GitHub access, model calls, and credentials on the
host. Model-controlled file and shell tools run in a fresh container with only
the ticket worktree mounted. The container receives no host environment, API
keys, SSH agent, or Docker socket.

Build on the current host:

```sh
docker build -t gary-executor:ubuntu24.04 docker/executor
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
docker/executor/warm-bun-cache.sh ~/.gary/workspaces/ERT-1234
```

The warm-up container sees only `package.json` and `bun.lock`, disables package
lifecycle scripts, and has network only for the duration of the explicit
operator action. A new worktree can then run `bun install --offline
--ignore-scripts` without gaining network access. Packages absent from that
cache must be admitted by an operator before the run;
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
