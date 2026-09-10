# Lean runner image for `docker run` / Kubernetes.
# Not a sandbox and not a toolchain image. Layer agent CLIs (claude, cursor,
# codex) and any script dependencies yourself.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY jaiph-linux-x64 /tmp/jaiph-linux-x64
COPY jaiph-linux-arm64 /tmp/jaiph-linux-arm64
RUN set -eu; \
    if [ "$TARGETARCH" = "arm64" ]; then src=/tmp/jaiph-linux-arm64; \
    else src=/tmp/jaiph-linux-x64; fi; \
    install -m 0755 "$src" /usr/local/bin/jaiph; \
    rm -f /tmp/jaiph-linux-x64 /tmp/jaiph-linux-arm64; \
    jaiph --version

# Matches docs/deploy/k8s.yaml runAsUser 10001.
RUN useradd --uid 10001 --create-home --shell /bin/bash jaiph
USER jaiph
WORKDIR /work
