# Just build everything in one go
FROM node:20 AS builder
WORKDIR /app

# Install pnpm first (this layer will be cached)
RUN npm install -g pnpm

# Copy everything
COPY . .

# Skip the Electron binary download (only needed by packages/desktop on
# developer machines, never in the server image)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install all dependencies (workspace handles conflicts)
RUN pnpm install

# Build shared packages first, then apps
RUN pnpm --filter @mako/schemas run build
RUN pnpm --filter @mako/agent-tools run build
RUN pnpm run app:build
RUN pnpm run api:build

# Production stage
FROM node:20-slim
WORKDIR /app

# Install build tools needed for native modules (+ venv for the dbt runner)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Bake a pinned dbt Core venv with the supported warehouse adapters.
# The dbt runner (api/src/dbt/dbt-bin.ts) resolves the binary via DBT_VENV_BIN.
RUN python3 -m venv /opt/dbt \
    && /opt/dbt/bin/pip install --no-cache-dir \
    "dbt-core==1.9.10" \
    "dbt-postgres==1.9.1" \
    "dbt-redshift==1.9.5" \
    "dbt-bigquery==1.9.2" \
    "dbt-clickhouse==1.9.2" \
    "dbt-sqlserver==1.9.0"
ENV DBT_VENV_BIN=/opt/dbt/bin/dbt

# dbt-mysql lags upstream (requires dbt-core ~=1.7), so it gets its own venv.
RUN python3 -m venv /opt/dbt-mysql \
    && /opt/dbt-mysql/bin/pip install --no-cache-dir \
    "dbt-core==1.7.19" \
    "dbt-mysql==1.7.0"
ENV DBT_MYSQL_VENV_BIN=/opt/dbt-mysql/bin/dbt

# Install pnpm in production too (this layer will be cached)
RUN npm install -g pnpm

# Set up minimal workspace so pnpm can resolve workspace:* deps
RUN echo '{"private":true}' > package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml

# Copy API package manifest
COPY --from=builder /app/api/package.json ./api/package.json

# Copy compiled shared schemas package (runtime dependency of API)
COPY --from=builder /app/packages/schemas/package.json ./packages/schemas/package.json
COPY --from=builder /app/packages/schemas/prepare.js ./packages/schemas/prepare.js
COPY --from=builder /app/packages/schemas/dist ./packages/schemas/dist

# Copy compiled shared agent-tools package (runtime dependency of API)
COPY --from=builder /app/packages/agent-tools/package.json ./packages/agent-tools/package.json
COPY --from=builder /app/packages/agent-tools/prepare.js ./packages/agent-tools/prepare.js
COPY --from=builder /app/packages/agent-tools/dist ./packages/agent-tools/dist

# Install production dependencies
RUN pnpm install --prod --filter api...

# Copy built API into api/dist and frontend into api/public
# (API server resolves public/ from process.cwd())
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/app/dist ./api/public

WORKDIR /app/api

ENV PORT=8080
EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=1024 --expose-gc"

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
