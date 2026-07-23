FROM node:22-bookworm-slim AS builder

WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# npm ci / npm pack run the `prepare` script (tools/embed-assets.js), which
# reads docs/jaiph-skill.md to regenerate the embedded assets — that source
# must be in the build context.
COPY tools ./tools
COPY docs/jaiph-skill.md ./docs/jaiph-skill.md
RUN npm ci && npm run build && npm pack --pack-destination /tmp >/dev/null && mv /tmp/jaiph-*.tgz /tmp/jaiph.tgz

FROM ubuntu:24.04

# Broad workflow toolchain for the sandbox runtime.
# Curated for generic engineering: VCS, shell, JS/Python, Go, Java, Rust,
# GitHub CLI, and common build utilities — not full CI-VM parity.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      curl \
      wget \
      git \
      ca-certificates \
      gnupg \
      jq \
      ripgrep \
      unzip \
      zip \
      xz-utils \
      procps \
      iproute2 \
      dnsutils \
      netcat-openbsd \
      openssh-client \
      python3 \
      python3-pip \
      python-is-python3 \
      util-linux \
      make \
      g++ \
      pkg-config \
      libssl-dev \
      file \
      sqlite3 \
      shellcheck \
      openjdk-21-jdk-headless \
      cmake \
      git-lfs \
      pipx \
      maven \
      gradle \
      protobuf-compiler \
      just \
      rsync && \
    rm -rf /var/lib/apt/lists/*

# JAVA_HOME must work on both amd64 and arm64 publish targets.
RUN ARCH="$(dpkg --print-architecture)" && \
    ln -sfn "/usr/lib/jvm/java-21-openjdk-${ARCH}" /usr/lib/jvm/java-21-openjdk-jaiph
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-jaiph

# GitHub CLI — PR/CI automation (e.g. jaiphlang/gh_actions).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Node.js — set up NodeSource APT repository via GPG key; no installer-script
# execution (same pattern as the GitHub CLI block above).
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# JS package managers (pnpm is not on GitHub-hosted runners either — workflows
# install it explicitly; we preinstall the common trio for sandbox scripts).
RUN npm install -g pnpm yarn && corepack enable

# Fast Python env/deps (common alternative to raw pip in modern repos).
# ARG UV_INSTALL_SHA256: sha256 of https://astral.sh/uv/install.sh at build time.
# Leave empty for dev builds; CI/release builds should populate this to pin the script.
ARG UV_INSTALL_SHA256=""
RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh; \
    if [ -n "${UV_INSTALL_SHA256}" ]; then \
      printf '%s  /tmp/uv-install.sh\n' "${UV_INSTALL_SHA256}" | sha256sum -c -; \
    fi; \
    env UV_INSTALL_DIR=/usr/local/bin sh /tmp/uv-install.sh; \
    rm -f /tmp/uv-install.sh

# Go — single stable release; matches go.dev "current stable" at image build time.
ARG GO_VERSION=1.26.5
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust — minimal stable toolchain (rustc + cargo + std); enough for most crates.
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"
# ARG RUSTUP_INIT_SHA256: sha256 of https://sh.rustup.rs at build time.
# Leave empty for dev builds; CI/release builds should populate this to pin the script.
ARG RUSTUP_INIT_SHA256=""
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh; \
    if [ -n "${RUSTUP_INIT_SHA256}" ]; then \
      printf '%s  /tmp/rustup-init.sh\n' "${RUSTUP_INIT_SHA256}" | sha256sum -c -; \
    fi; \
    sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal --no-modify-path; \
    rm -f /tmp/rustup-init.sh; \
    chmod -R a+rx /usr/local/rustup /usr/local/cargo

# YAML CLI (mikefarah/yq — distinct from the Python yq package).
ARG YQ_VERSION=4.45.4
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) yqarch=amd64 ;; \
      arm64) yqarch=arm64 ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${yqarch}" \
      -o /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# Bun — fast JS runtime used by many modern repos (and Jaiph's own build).
ENV BUN_INSTALL=/usr/local/bun
# ARG BUN_INSTALL_SHA256: sha256 of https://bun.sh/install at build time.
# Leave empty for dev builds; CI/release builds should populate this to pin the script.
ARG BUN_INSTALL_SHA256=""
RUN set -eux; \
    curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh; \
    if [ -n "${BUN_INSTALL_SHA256}" ]; then \
      printf '%s  /tmp/bun-install.sh\n' "${BUN_INSTALL_SHA256}" | sha256sum -c -; \
    fi; \
    env BUN_INSTALL="${BUN_INSTALL}" bash /tmp/bun-install.sh; \
    rm -f /tmp/bun-install.sh
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# kubectl — Kubernetes cluster automation.
ARG KUBECTL_VERSION=1.36.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) karch=amd64 ;; \
      arm64) karch=arm64 ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${karch}/kubectl" \
      -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

# AWS CLI v2 — cloud automation scripts.
RUN set -eux; \
    arch="$(uname -m)"; \
    case "${arch}" in \
      x86_64) awsarch=x86_64 ;; \
      aarch64) awsarch=aarch64 ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsarch}.zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Task (go-task) — Makefile-style task runner used in many repos.
ARG TASK_VERSION=3.44.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) taskarch=amd64 ;; \
      arm64) taskarch=arm64 ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/go-task/task/releases/download/v${TASK_VERSION}/task_linux_${taskarch}.tar.gz" \
      | tar -xz -C /usr/local/bin task && \
    chmod +x /usr/local/bin/task

# Non-root user for agent CLIs and default shell behavior. The workspace and
# run bind mounts are created and owned by the host UID at run time, so no
# root-owned mountpoint is needed.
RUN useradd --create-home --uid 10001 --shell /bin/bash jaiph && \
    mkdir -p /jaiph/workspace /jaiph/run && \
    chown -R jaiph:jaiph /jaiph && \
    chmod 755 /home/jaiph

# Claude Code CLI (Anthropic) — global install for all users
RUN npm install -g @anthropic-ai/claude-code

# Install jaiph built from repository source (builder stage).
COPY --from=builder /tmp/jaiph.tgz /tmp/jaiph.tgz
RUN npm install -g /tmp/jaiph.tgz && rm -f /tmp/jaiph.tgz

USER jaiph
ENV HOME=/home/jaiph
ENV PATH="/home/jaiph/.local/bin:/usr/local/bun/bin:/usr/local/cargo/bin:/usr/local/go/bin:${JAVA_HOME}/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# cursor-agent (Cursor) — install as the runtime user so the binary is
# reachable after switching away from root. The installer currently places
# the CLI in ~/.local/bin and may name it "agent" or "cursor".
# ARG CURSOR_INSTALL_SHA256: sha256 of https://cursor.com/install at build time.
# Cursor does not publish checksums publicly; set this ARG when the hash is known.
ARG CURSOR_INSTALL_SHA256=""
RUN mkdir -p "$HOME/.local/bin" && \
    curl -fsSL https://cursor.com/install -o /tmp/install-cursor-agent.sh && \
    if [ -n "${CURSOR_INSTALL_SHA256}" ]; then \
      printf '%s  /tmp/install-cursor-agent.sh\n' "${CURSOR_INSTALL_SHA256}" | sha256sum -c -; \
    fi && \
    bash /tmp/install-cursor-agent.sh && \
    export PATH="$HOME/.local/bin:$PATH" && \
    if command -v cursor-agent >/dev/null 2>&1; then \
      true; \
    elif command -v agent >/dev/null 2>&1; then \
      ln -sf "$(command -v agent)" "$HOME/.local/bin/cursor-agent"; \
    elif command -v cursor >/dev/null 2>&1; then \
      ln -sf "$(command -v cursor)" "$HOME/.local/bin/cursor-agent"; \
    fi && \
    command -v cursor-agent >/dev/null 2>&1 && \
    rm -f /tmp/install-cursor-agent.sh

# At runtime the container starts as the host UID directly — not the `jaiph`
# user that owns /home/jaiph. cursor-agent (~/.cursor) and claude CLI
# (~/.claude*) need to
# create state files inside HOME, which would fail without write permission.
# Apply 1777 (world-writable + sticky) to every dir under /home/jaiph so any
# UID can create new files; existing files keep their modes and the sticky bit
# prevents non-owners from deleting/replacing the installed binaries.
USER root
RUN find /home/jaiph -type d -exec chmod 1777 {} +
USER jaiph

WORKDIR /jaiph/workspace
