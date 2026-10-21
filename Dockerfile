FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY config ./config
COPY agent ./agent
RUN mkdir /app/.local && chown -R node:node /app
USER node
ENV SRE_HOST=0.0.0.0 SRE_PORT=3001 SRE_CONFIG=config/sre.connected.example.json
EXPOSE 3001 3978
CMD ["node", "src/sre/server.mjs"]
