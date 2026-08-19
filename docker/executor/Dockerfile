ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:d78ab76437b1afc5f01e223d6bf0172763f404bb166441328845adbef44518cb

FROM ${BUN_IMAGE} AS bun

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
      python3 \
      ripgrep \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN groupadd --gid 10001 gary \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash gary \
    && mkdir -p /source /workspace \
    && chown gary:gary /source /workspace

USER gary
WORKDIR /workspace
CMD ["bash"]
