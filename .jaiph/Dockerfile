FROM ubuntu:latest

# Standard utilities
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      curl \
      git \
      ca-certificates \
      gnupg && \
    rm -rf /var/lib/apt/lists/*

# Node.js latest LTS (required by jaiph::stream_json_to_text in prompt.sh)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI (Anthropic)
RUN npm install -g @anthropic-ai/claude-code

# cursor-agent (Cursor) — installed via Cursor's official distribution.
# The installer currently places the CLI in ~/.local/bin and names it "agent".
# Normalize to /usr/local/bin/cursor-agent so jaiph runtime can invoke it.
RUN curl -fsSL https://cursor.com/install -o /tmp/install-cursor-agent.sh && \
    bash /tmp/install-cursor-agent.sh && \
    export PATH="$HOME/.local/bin:$PATH" && \
    if command -v cursor-agent >/dev/null 2>&1; then \
      ln -sf "$(command -v cursor-agent)" /usr/local/bin/cursor-agent; \
    elif command -v agent >/dev/null 2>&1; then \
      ln -sf "$(command -v agent)" /usr/local/bin/cursor-agent; \
    elif command -v cursor >/dev/null 2>&1; then \
      ln -sf "$(command -v cursor)" /usr/local/bin/cursor-agent; \
    fi && \
    command -v cursor-agent >/dev/null 2>&1 && \
    rm -f /tmp/install-cursor-agent.sh

WORKDIR /jaiph/workspace
