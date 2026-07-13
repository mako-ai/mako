# syntax=docker/dockerfile:1
#
# Dual-mode production image:
# - Default (USE_PREBUILT=0): build from source inside Docker (local `docker build -t mako .`)
# - CI (USE_PREBUILT=1): package host-built dist/ artifacts (avoids rebuilding twice)
#
# Runtime layers (apt, dbt venvs, pnpm) are ordered for BuildKit cache reuse.

# =============================================================================
# Builder: compile from source (local / docs path)
# =============================================================================
FROM node:20 AS builder-source
WORKDIR /app

RUN npm install -g pnpm

# Skip the Electron binary download (only needed by packages/desktop on
# developer machines, never in the server image)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Manifests first so dependency installs stay cached across source-only changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json ./app/package.json
COPY api/package.json ./api/package.json
COPY docs/package.json ./docs/package.json
COPY packages/schemas/package.json packages/schemas/prepare.js ./packages/schemas/
COPY packages/agent-tools/package.json packages/agent-tools/prepare.js ./packages/agent-tools/
COPY packages/desktop/package.json ./packages/desktop/package.json
COPY packages/local-agent/package.json ./packages/local-agent/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @mako/schemas run build \
  && pnpm --filter @mako/agent-tools run build \
  && pnpm run app:build \
  && pnpm run api:build

# =============================================================================
# Builder: stage host-built artifacts (CI path)
# =============================================================================
FROM node:20 AS builder-prebuilt
WORKDIR /app

# Same paths the production stage expects from the source builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY packages/schemas/package.json packages/schemas/prepare.js ./packages/schemas/
COPY packages/schemas/dist ./packages/schemas/dist
COPY packages/agent-tools/package.json packages/agent-tools/prepare.js ./packages/agent-tools/
COPY packages/agent-tools/dist ./packages/agent-tools/dist
COPY api/dist ./api/dist
COPY app/dist ./app/dist

# =============================================================================
# Select builder based on USE_PREBUILT (0 = source, 1 = prebuilt)
# =============================================================================
ARG USE_PREBUILT=0
FROM builder-source AS builder-0
FROM builder-prebuilt AS builder-1
FROM builder-${USE_PREBUILT} AS builder

# =============================================================================
# Production runtime
# =============================================================================
FROM node:20-slim
WORKDIR /app

# Install build tools needed for native modules (+ venv for the dbt runner).
# This layer is stable and should stay cached across app deploys.
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

RUN npm install -g pnpm

# Minimal workspace so pnpm can resolve workspace:* deps
RUN echo '{"private":true}' > package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml

# Package manifests only — keeps prod install cached when only compiled output changes
COPY --from=builder /app/api/package.json ./api/package.json
COPY --from=builder /app/packages/schemas/package.json ./packages/schemas/package.json
COPY --from=builder /app/packages/schemas/prepare.js ./packages/schemas/prepare.js
COPY --from=builder /app/packages/agent-tools/package.json ./packages/agent-tools/package.json
COPY --from=builder /app/packages/agent-tools/prepare.js ./packages/agent-tools/prepare.js

# Placeholder dist dirs so prepare hooks / package mains resolve during install
RUN mkdir -p packages/schemas/dist packages/agent-tools/dist

RUN pnpm install --prod --filter api...

# Copy compiled shared packages + app/API output
COPY --from=builder /app/packages/schemas/dist ./packages/schemas/dist
COPY --from=builder /app/packages/agent-tools/dist ./packages/agent-tools/dist
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/app/dist ./api/public

WORKDIR /app/api

ENV PORT=8080
EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=1024 --expose-gc"

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
