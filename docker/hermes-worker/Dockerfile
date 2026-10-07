# linux/arm64, official Docker Library Python 3.11.17, resolved 2026-10-07.
FROM python:3.11-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89 AS dependencies
COPY requirements-linux-arm64.txt /opt/gary-build/requirements-linux-arm64.txt
# Only pinned binary wheel URLs on files.pythonhosted.org; no resolver or sdists.
RUN python -I -m pip install --disable-pip-version-check --no-cache-dir --no-deps --require-hashes --only-binary=:all: --no-compile -r /opt/gary-build/requirements-linux-arm64.txt \
    && python -I -m pip check

FROM dependencies AS source
COPY hermes-source.tar /tmp/hermes-source.tar
COPY extract-source.py /tmp/extract-source.py
RUN python -I -B /tmp/extract-source.py \
    && rm /tmp/hermes-source.tar /tmp/extract-source.py

FROM source AS worker
COPY gary_runtime.py /opt/gary-hermes-runtime/python/gary_runtime.py
COPY SOURCE.json /opt/gary-hermes-runtime/SOURCE.json
COPY dependency-lock.json /opt/gary-build/dependency-lock.json
COPY attest-image.py /usr/local/libexec/gary-worker-source-attestation.py
RUN python -I -B /usr/local/libexec/gary-worker-source-attestation.py > /opt/gary-build/source-attestation.json
USER 65532:65532
WORKDIR /opt/gary-hermes-runtime
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "python", "-I", "-B", "python/gary_runtime.py", "--stdio"]
