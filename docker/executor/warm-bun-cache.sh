#!/bin/sh
set -eu

workspace="${1:?usage: warm-bun-cache.sh /absolute/project/worktree}"
image="${GARY_EXECUTOR_IMAGE:-gary-executor:ubuntu24.04}"
volume="${GARY_BUN_CACHE_VOLUME:-gary-bun-cache}"

case "$workspace" in
  /*) ;;
  *) echo "workspace must be an absolute path" >&2; exit 2 ;;
esac
case "$volume" in
  *[!A-Za-z0-9_.-]*|'') echo "invalid Docker volume name: $volume" >&2; exit 2 ;;
esac
for file in package.json bun.lock; do
  if [ ! -f "${workspace}/${file}" ]; then
    echo "missing ${workspace}/${file}" >&2
    exit 2
  fi
done

docker volume create "$volume" >/dev/null
docker run --rm --init --pull=never \
  --network bridge \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit 512 \
  --memory 6g \
  --cpus 4 \
  --tmpfs /workspace:rw,noexec,nosuid,nodev,size=2g \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g \
  --mount "type=bind,src=${workspace}/package.json,dst=/source/package.json,readonly" \
  --mount "type=bind,src=${workspace}/bun.lock,dst=/source/bun.lock,readonly" \
  --mount "type=volume,src=${volume},dst=/bun-cache" \
  --env BUN_INSTALL_CACHE_DIR=/bun-cache \
  --workdir /workspace \
  --user 0:0 \
  "$image" \
  bash -c 'cp /source/package.json /source/bun.lock . && bun install --ignore-scripts --frozen-lockfile'

echo "warmed ${volume} from ${workspace}/bun.lock (lifecycle scripts disabled)"
