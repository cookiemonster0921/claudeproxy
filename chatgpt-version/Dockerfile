FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tmux \
        unzip && \
    rm -rf /var/lib/apt/lists/*

# Bun runs the Discord MCP server directly from TypeScript.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/root/.local/bin:$PATH"

# Install the native Claude Code CLI.
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV CLAUDE_CODE_SKIP_TELEMETRY=1

COPY plugin /app/plugin
RUN cd /app/plugin && bun install --frozen-lockfile --no-summary

COPY entrypoint.sh /usr/local/bin/discord-channel-entrypoint
RUN chmod +x /usr/local/bin/discord-channel-entrypoint

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/discord-channel-entrypoint"]
