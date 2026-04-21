FROM node:22-bookworm-slim AS builder

WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm pack --pack-destination /tmp >/dev/null && mv /tmp/jaiph-*.tgz /tmp/jaiph.tgz

FROM ubuntu:24.04

# Broad workflow toolchain + fuse-overlayfs for CoW sandbox.
# This image is intended to execute diverse custom scripts, so we include
# common build, scripting, archive, and network diagnostics tooling.
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
      fuse-overlayfs \
      fuse3 \
      rsync && \
    rm -rf /var/lib/apt/lists/*

# Node.js for running jaiph
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Non-root user for agent CLIs and default shell behavior. /jaiph/workspace is
# root-owned because Linux overlay mode mounts there as --user 0:0.
RUN useradd --create-home --uid 10001 --shell /bin/bash jaiph && \
    mkdir -p /jaiph/workspace /jaiph/workspace-ro /jaiph/run && \
    chown -R jaiph:jaiph /jaiph && \
    chown root:root /jaiph/workspace && \
    chmod 755 /home/jaiph

# Claude Code CLI (Anthropic) — global install for all users
RUN npm install -g @anthropic-ai/claude-code

# Install jaiph built from repository source (builder stage).
COPY --from=builder /tmp/jaiph.tgz /tmp/jaiph.tgz
RUN npm install -g /tmp/jaiph.tgz && rm -f /tmp/jaiph.tgz

USER jaiph
ENV HOME=/home/jaiph
ENV PATH="/home/jaiph/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# cursor-agent (Cursor) — install as the runtime user so the binary is
# reachable after switching away from root. The installer currently places
# the CLI in ~/.local/bin and may name it "agent" or "cursor".
RUN mkdir -p "$HOME/.local/bin" && \
    curl -fsSL https://cursor.com/install -o /tmp/install-cursor-agent.sh && \
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

WORKDIR /jaiph/workspace
