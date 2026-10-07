ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:d78ab76437b1afc5f01e223d6bf0172763f404bb166441328845adbef44518cb

FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS node

FROM ${UBUNTU_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      file \
      findutils \
      git \
      jq \
      libatomic1 \
      python3 \
      ripgrep \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Running the copied binary also verifies its shared-library compatibility with
# Ubuntu on the selected architecture. Bun remains the package/script launcher.
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && test "$(node --version)" = "v24.21.0" \
    && test "$(bun --version)" = "1.3.14"

RUN groupadd --gid 10001 gary \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash gary \
    && mkdir -p /source /workspace \
    && chown gary:gary /source /workspace

# Mulligan's Svelte/TypeScript checks exceed Node's default ~2 GiB heap. This
# stays within the executor's existing 12 GiB cgroup memory cap.
ENV NODE_OPTIONS=--max-old-space-size=8192

USER gary
WORKDIR /workspace
CMD ["bash"]
