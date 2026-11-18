ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=additional_ca \
    if [ -f /run/secrets/additional_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/additional_ca; fi; \
    npm ci --foreground-scripts --no-audit --no-fund || (tail -80 /root/.npm/_logs/*-debug-0.log; exit 1)
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production AGENT_TOWER_HOME=/state
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/daemon ./daemon
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /state /workspace /audit && chown node:node /state /workspace /audit
USER node
CMD ["node", "--import", "tsx", "daemon/hosted/main.ts"]
