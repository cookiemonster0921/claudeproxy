FROM node:22-slim

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 8080

ENV NODE_ENV=production
ENV CLAUDE_CODE_SKIP_TELEMETRY=1

CMD ["node", "dist/server.js"]
