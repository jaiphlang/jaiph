FROM ubuntu:latest

# Standard utilities + fuse-overlayfs for CoW sandbox
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      curl \
      git \
      ca-certificates \
      gnupg \
      fuse-overlayfs \
      fuse3 \
      rsync && \
    rm -rf /var/lib/apt/lists/*

# Node.js latest LTS (required by jaiph::stream_json_to_text in prompt.sh)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Non-root user: Claude Code (and similar tools) refuse --dangerously-skip-permissions
# when running as root. Jaiph only passes --user on Linux hosts; on macOS the container
# defaults to root unless the image sets USER.
RUN useradd --create-home --uid 10001 --shell /bin/bash jaiph && \
    mkdir -p /jaiph/workspace /jaiph/workspace-ro /jaiph/delta/files && \
    chown -R jaiph:jaiph /jaiph

# Claude Code CLI (Anthropic) — global install for all users
RUN npm install -g @anthropic-ai/claude-code

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

# jaiph (official installer: https://jaiph.org/install)
RUN curl -fsSL https://jaiph.org/install | bash
RUN jaiph use nightly

# Overlay wrapper: sets up fuse-overlayfs CoW on top of ro workspace mount,
# falls back to copy-on-start when FUSE is unavailable.
COPY --chmod=755 overlay-run.sh /jaiph/overlay-run.sh

WORKDIR /jaiph/workspace
