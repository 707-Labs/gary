#!/bin/sh
set -eu

workspace="${1:?usage: warm-bun-cache.sh /absolute/project/repository reviewed-git-commit}"
reviewed_ref="${2:?provide the reviewed Git commit containing package.json and bun.lock}"
image="${GARY_EXECUTOR_IMAGE:-gary-executor:ubuntu24.04}"
volume="${GARY_BUN_CACHE_VOLUME:-gary-bun-cache}"

case "$workspace" in
  /*) ;;
  *) echo "workspace must be an absolute path" >&2; exit 2 ;;
esac
case "$volume" in
  *[!A-Za-z0-9_.-]*|[!A-Za-z0-9]*|'') echo "invalid Docker volume name: $volume" >&2; exit 2 ;;
esac

# Resolve once, then read immutable Git objects rather than a possibly changing
# worktree. Only these two files cross into the warm-up container over stdin.
reviewed_commit="$(git -C "$workspace" rev-parse --verify --end-of-options "${reviewed_ref}^{commit}")"
snapshot="$(mktemp -d "${TMPDIR:-/tmp}/gary-bun-manifests.XXXXXXXX")"
trap 'rm -rf "$snapshot"' EXIT HUP INT TERM
for file in package.json bun.lock; do
  git -C "$workspace" show "${reviewed_commit}:${file}" > "${snapshot}/${file}"
done
# macOS tar otherwise adds AppleDouble/xattr entries. Use a portable archive
# containing only the two regular files; no host ownership needs to survive.
COPYFILE_DISABLE=1 tar --format=ustar -C "$snapshot" -cf "$snapshot/manifests.tar" package.json bun.lock

# No pull occurs here. Pin the already-built local image for the whole warm-up,
# even if its human-readable tag changes while the install is running.
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
case "$image_id" in
  sha256:*) ;;
  *) echo "could not resolve local executor image: $image" >&2; exit 2 ;;
esac

docker volume create "$volume" >/dev/null
docker run --rm --init --interactive --pull=never \
  --network bridge \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit 512 \
  --memory 6g \
  --cpus 4 \
  --tmpfs /workspace:rw,noexec,nosuid,nodev,size=2g \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  --mount "type=volume,src=${volume},dst=/bun-cache" \
  --env BUN_INSTALL_CACHE_DIR=/bun-cache \
  --workdir /workspace \
  --user 0:0 \
  "$image_id" \
  bash -c 'set -euo pipefail; tar --no-same-owner -xf -; sha256sum package.json bun.lock; node --version; bun --version; bun install --ignore-scripts --frozen-lockfile' \
  < "$snapshot/manifests.tar"

echo "warmed ${volume} from commit ${reviewed_commit} using ${image_id} (lifecycle scripts disabled)"
