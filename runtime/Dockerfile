# Base images are pinned by digest (not just a mutable tag) so the built image
# is reproducible and its registry-sourced layers are attested (finding L-4,
# ASI-09). Refresh the @sha256: digest when intentionally bumping the tag.
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS builder

WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# npm ci / npm pack run the `prepare` script (tools/embed-assets.js), which
# reads docs/jaiph-skill.md to regenerate the embedded assets — that source
# must be in the build context.
COPY tools ./tools
COPY docs/jaiph-skill.md ./docs/jaiph-skill.md
RUN npm ci && npm run build && npm pack --pack-destination /tmp >/dev/null && mv /tmp/jaiph-*.tgz /tmp/jaiph.tgz

# Pinned by digest for the same reproducibility/provenance reason as the builder
# base above (finding L-4). Refresh the @sha256: digest when bumping the tag.
FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

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

# Single fail-closed download+verify seam for every toolchain fetch below
# (finding M-11). Installed early so every subsequent RUN — including the ones
# that run as the non-root `jaiph` user — can call it by name.
COPY runtime/fetch-verify.sh /usr/local/bin/fetch-verify.sh
RUN chmod 0755 /usr/local/bin/fetch-verify.sh

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
# Versions are pinned exactly so the registry-sourced install is reproducible
# (finding L-4); npm verifies each pinned version's tarball integrity against the
# registry. Bump these deliberately. Empty would let npm resolve a mutable tag.
ARG PNPM_VERSION=11.18.0
ARG YARN_VERSION=1.22.22
RUN npm install -g "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" && corepack enable

# Fast Python env/deps (common alternative to raw pip in modern repos).
# UV_INSTALL_SHA256: sha256 of https://astral.sh/uv/install.sh. This is a rolling
# URL — refresh the pin when upstream changes the installer. Empty fails closed.
ARG UV_INSTALL_SHA256=58bee0cf8814385d5ffc2324e06d63db29de35ce8e740b9cadd2529bff929f50
RUN set -eux; \
    fetch-verify.sh https://astral.sh/uv/install.sh /tmp/uv-install.sh "${UV_INSTALL_SHA256}"; \
    env UV_INSTALL_DIR=/usr/local/bin sh /tmp/uv-install.sh; \
    rm -f /tmp/uv-install.sh

# Go — single stable release; matches go.dev "current stable" at image build time.
ARG GO_VERSION=1.26.5
ARG GO_SHA256_AMD64=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
ARG GO_SHA256_ARM64=fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) goarch=amd64; gosha="${GO_SHA256_AMD64}" ;; \
      arm64) goarch=arm64; gosha="${GO_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    fetch-verify.sh "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" /tmp/go.tar.gz "${gosha}"; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm -f /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust — minimal stable toolchain (rustc + cargo + std); enough for most crates.
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"
# RUSTUP_INIT_SHA256: sha256 of https://sh.rustup.rs. Rolling URL — refresh the
# pin when upstream changes the installer. Empty fails closed.
ARG RUSTUP_INIT_SHA256=6c30b75a75b28a96fd913a037c8581b580080b6ee9b8169a3c0feb1af7fe8caf
RUN set -eux; \
    fetch-verify.sh https://sh.rustup.rs /tmp/rustup-init.sh "${RUSTUP_INIT_SHA256}"; \
    sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal --no-modify-path; \
    rm -f /tmp/rustup-init.sh; \
    chmod -R a+rx /usr/local/rustup /usr/local/cargo

# YAML CLI (mikefarah/yq — distinct from the Python yq package).
ARG YQ_VERSION=4.45.4
ARG YQ_SHA256_AMD64=b96de04645707e14a12f52c37e6266832e03c29e95b9b139cddcae7314466e69
ARG YQ_SHA256_ARM64=a02cc637409db44a9f9cb55ea92c40019582ba88083c4d930a727ec4b59ed439
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) yqarch=amd64; yqsha="${YQ_SHA256_AMD64}" ;; \
      arm64) yqarch=arm64; yqsha="${YQ_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    fetch-verify.sh "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${yqarch}" \
      /usr/local/bin/yq "${yqsha}"; \
    chmod +x /usr/local/bin/yq

# Bun — fast JS runtime used by many modern repos (and Jaiph's own build).
ENV BUN_INSTALL=/usr/local/bun
# BUN_INSTALL_SHA256: sha256 of https://bun.sh/install. Rolling URL — refresh the
# pin when upstream changes the installer. Empty fails closed.
ARG BUN_INSTALL_SHA256=bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd
RUN set -eux; \
    fetch-verify.sh https://bun.sh/install /tmp/bun-install.sh "${BUN_INSTALL_SHA256}"; \
    env BUN_INSTALL="${BUN_INSTALL}" bash /tmp/bun-install.sh; \
    rm -f /tmp/bun-install.sh
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# kubectl — Kubernetes cluster automation.
ARG KUBECTL_VERSION=1.36.2
ARG KUBECTL_SHA256_AMD64=1e9045ec32bea85da43de85f0065358529ea7c7a152eca78154fba5b58c27d82
ARG KUBECTL_SHA256_ARM64=c957eb8c4bea27a3bb35b269edd9082e27f027f7b76b20b5bf4afebc726c6d3e
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) karch=amd64; ksha="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) karch=arm64; ksha="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    fetch-verify.sh "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${karch}/kubectl" \
      /usr/local/bin/kubectl "${ksha}"; \
    chmod +x /usr/local/bin/kubectl

# AWS CLI v2 — cloud automation scripts. The download URL is unversioned
# ("latest"), so these pins must be refreshed when AWS ships a new CLI build.
# Empty fails closed.
ARG AWSCLI_SHA256_X86_64=7e3b004e49c4550729fddbdc7f199b07b2288fe73a41ac0fcc8f5b873c938f7b
ARG AWSCLI_SHA256_AARCH64=a820e168234363fb630da717111b6d94e6cd3712e3552da340e9910420d17cac
RUN set -eux; \
    arch="$(uname -m)"; \
    case "${arch}" in \
      x86_64) awsarch=x86_64; awssha="${AWSCLI_SHA256_X86_64}" ;; \
      aarch64) awsarch=aarch64; awssha="${AWSCLI_SHA256_AARCH64}" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    fetch-verify.sh "https://awscli.amazonaws.com/awscli-exe-linux-${awsarch}.zip" /tmp/awscliv2.zip "${awssha}"; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Task (go-task) — Makefile-style task runner used in many repos.
ARG TASK_VERSION=3.44.1
ARG TASK_SHA256_AMD64=62969d22bee5ea8950cc64a30cc7eb278f89ad67683132e728841457aae523c1
ARG TASK_SHA256_ARM64=06f390bbc1545997bc08920b51741dd2142713cfdef748e5b17e9f68aa042bbd
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) taskarch=amd64; tasksha="${TASK_SHA256_AMD64}" ;; \
      arm64) taskarch=arm64; tasksha="${TASK_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    fetch-verify.sh "https://github.com/go-task/task/releases/download/v${TASK_VERSION}/task_linux_${taskarch}.tar.gz" \
      /tmp/task.tar.gz "${tasksha}"; \
    tar -xzf /tmp/task.tar.gz -C /usr/local/bin task; \
    rm -f /tmp/task.tar.gz; \
    chmod +x /usr/local/bin/task

# Non-root user for agent CLIs and default shell behavior. The workspace and
# run bind mounts are created and owned by the host UID at run time, so no
# root-owned mountpoint is needed.
RUN useradd --create-home --uid 10001 --shell /bin/bash jaiph && \
    mkdir -p /jaiph/workspace /jaiph/run && \
    chown -R jaiph:jaiph /jaiph && \
    chmod 755 /home/jaiph

# Claude Code CLI (Anthropic) — global install for all users. Pinned exactly for
# reproducible, integrity-checked provenance (finding L-4); bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.220
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Install jaiph built from repository source (builder stage).
COPY --from=builder /tmp/jaiph.tgz /tmp/jaiph.tgz
RUN npm install -g /tmp/jaiph.tgz && rm -f /tmp/jaiph.tgz

USER jaiph
ENV HOME=/home/jaiph
ENV PATH="/home/jaiph/.local/bin:/usr/local/bun/bin:/usr/local/cargo/bin:/usr/local/go/bin:${JAVA_HOME}/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# cursor-agent (Cursor) — install as the runtime user so the binary is
# reachable after switching away from root. The installer currently places
# the CLI in ~/.local/bin and may name it "agent" or "cursor".
# CURSOR_INSTALL_SHA256: sha256 of https://cursor.com/install. Cursor does not
# publish checksums, and the URL is rolling — refresh this pin when upstream
# changes the installer. Empty fails closed.
ARG CURSOR_INSTALL_SHA256=a51ebedf2a13bc073d994a6f2defbd1f4d976a6cf116ad678d071c6a363bf3e4
RUN mkdir -p "$HOME/.local/bin" && \
    fetch-verify.sh https://cursor.com/install /tmp/install-cursor-agent.sh "${CURSOR_INSTALL_SHA256}" && \
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

# Default to host-mode execution: inside this image, the container IS the
# sandbox, so jaiph must not try to launch a nested Docker daemon (there is
# none), and the interactive `--unsafe` confirmation is impossible/meaningless
# in an unattended pod. This only affects the image run *standalone*
# (`docker run … jaiph run flow.jh`, or as a k8s pod); when the image is used
# as a host-orchestrated sandbox rootfs the inner invocation is
# `jaiph run --raw`, which never launches Docker regardless of JAIPH_UNSAFE, so
# host-orchestrated sandbox behavior is unchanged. See docs/deploy.md.
ENV JAIPH_UNSAFE=true

WORKDIR /jaiph/workspace
