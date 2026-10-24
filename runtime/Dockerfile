# Runner image for `docker run` / Kubernetes.
# Not a sandbox and not a language toolchain. `claude`, `cursor-agent`, and
# `codex` are on PATH. Add script interpreters (node, go, …) in a derived image.
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

# Agent CLIs live under /usr/local and /opt so they stay on PATH when HOME is
# a writable emptyDir (docs/deploy/k8s.yaml). Refresh each version and sha256
# together. An empty or mismatched checksum fails the build.
ARG CLAUDE_VERSION=2.1.310
ARG CLAUDE_SHA256_AMD64=5bea9e13ac07ea6804c24e6263ec7e5b3d13f81d3f681c92f9784c534425fae1
ARG CLAUDE_SHA256_ARM64=97ab45a42fdb141dc37d3b12973638ebd8fda59163eca51b02aa2eded0630874
ARG CODEX_VERSION=0.164.0
ARG CODEX_SHA256_AMD64=90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4
ARG CODEX_SHA256_ARM64=29a507a2a3fd8f6cd94b96b762d281d299d15d7902dee6132d314b78cf9108eb
ARG CURSOR_VERSION=2026.10.22-27dcf5f
ARG CURSOR_SHA256_AMD64=85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294
ARG CURSOR_SHA256_ARM64=22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) \
        claude_url="https://github.com/anthropics/claude-code/releases/download/v${CLAUDE_VERSION}/claude-linux-x64.tar.gz"; \
        claude_sha="$CLAUDE_SHA256_AMD64"; \
        codex_url="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz"; \
        codex_sha="$CODEX_SHA256_AMD64"; \
        codex_name="codex-x86_64-unknown-linux-musl"; \
        cursor_url="https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/x64/agent-cli-package.tar.gz"; \
        cursor_sha="$CURSOR_SHA256_AMD64"; \
        ;; \
      arm64) \
        claude_url="https://github.com/anthropics/claude-code/releases/download/v${CLAUDE_VERSION}/claude-linux-arm64.tar.gz"; \
        claude_sha="$CLAUDE_SHA256_ARM64"; \
        codex_url="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-aarch64-unknown-linux-musl.tar.gz"; \
        codex_sha="$CODEX_SHA256_ARM64"; \
        codex_name="codex-aarch64-unknown-linux-musl"; \
        cursor_url="https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/arm64/agent-cli-package.tar.gz"; \
        cursor_sha="$CURSOR_SHA256_ARM64"; \
        ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    fetch() { \
      url="$1"; sha="$2"; dest="$3"; \
      curl -fsSL "$url" -o "$dest"; \
      echo "${sha}  ${dest}" | sha256sum -c -; \
    }; \
    fetch "$claude_url" "$claude_sha" /tmp/claude.tar.gz; \
    tar -xzf /tmp/claude.tar.gz -C /usr/local/bin claude; \
    chmod 0755 /usr/local/bin/claude; \
    fetch "$codex_url" "$codex_sha" /tmp/codex.tar.gz; \
    tar -xzf /tmp/codex.tar.gz -C /tmp "$codex_name"; \
    install -m 0755 "/tmp/${codex_name}" /usr/local/bin/codex; \
    fetch "$cursor_url" "$cursor_sha" /tmp/cursor.tar.gz; \
    mkdir -p /opt/cursor-agent; \
    tar -xzf /tmp/cursor.tar.gz -C /opt/cursor-agent --strip-components=1; \
    chmod -R a+rX /opt/cursor-agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
    rm -rf /tmp/claude.tar.gz /tmp/codex.tar.gz /tmp/cursor.tar.gz "/tmp/${codex_name}"; \
    claude --version; \
    cursor-agent --version; \
    codex --version

# Matches docs/deploy/k8s.yaml runAsUser 10001.
RUN useradd --uid 10001 --create-home --shell /bin/bash jaiph
USER jaiph
WORKDIR /work
