# syntax=docker/dockerfile:1
#
# Dual-mode production image:
# - Default (USE_PREBUILT=0): build from source inside Docker (local `docker build -t mako .`)
# - CI (USE_PREBUILT=1): package host-built dist/ artifacts (avoids rebuilding twice)
#
# Runtime layers (apt, dbt venvs, prod node_modules) are ordered for BuildKit
# cache reuse. Compilers live only in the build stages: native modules and the
# dbt venvs are built there and copied into a slim runtime that runs as `node`.
#
# pnpm is the exact version in the root package.json `packageManager` field,
# activated by corepack (the same pin CI uses).

# Must be declared before any FROM so it can interpolate the builder selector stage.
ARG USE_PREBUILT=0

# =============================================================================
# Builder: compile from source (local / docs path)
# =============================================================================
FROM node:24.22.1-bookworm AS builder-source
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Skip the Electron binary download (only needed by packages/desktop on
# developer machines, never in the server image)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Manifests first so dependency installs stay cached across source-only changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json ./app/package.json
COPY api/package.json ./api/package.json
COPY docs/package.json ./docs/package.json
# schemas and agent-tools come in whole: their `prepare` hooks compile them
# with tsc during the install, which needs their tsconfig and sources.
COPY packages/schemas ./packages/schemas
COPY packages/agent-tools ./packages/agent-tools
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
FROM node:24.22.1-bookworm AS builder-prebuilt
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
FROM builder-source AS builder-0
FROM builder-prebuilt AS builder-1
FROM builder-${USE_PREBUILT} AS builder

# =============================================================================
# dbt venvs (pip may compile wheels; the compilers stay in this stage)
# =============================================================================
# Same Debian release as the runtime, so /usr/bin/python3 (the venvs'
# interpreter) is the same Python there.
FROM node:24.22.1-bookworm AS dbt-venvs
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
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

# dbt-mysql lags upstream (requires dbt-core ~=1.7), so it gets its own venv.
RUN python3 -m venv /opt/dbt-mysql \
    && /opt/dbt-mysql/bin/pip install --no-cache-dir \
    "dbt-core==1.7.19" \
    "dbt-mysql==1.7.0"

# =============================================================================
# Production node_modules (native modules compile here, never at runtime)
# =============================================================================
FROM node:24.22.1-bookworm AS prod-deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# The real root manifest (packageManager pin, overrides via the workspace
# file) and the lockfile, so the install is --frozen-lockfile.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
# The root `prepare` hook runs husky, a devDependency absent from a --prod
# install. Scripts are not part of the lockfile check.
RUN npm pkg delete scripts.prepare

# Package manifests only — keeps prod install cached when only compiled output changes
COPY --from=builder /app/api/package.json ./api/package.json
COPY --from=builder /app/packages/schemas/package.json ./packages/schemas/package.json
COPY --from=builder /app/packages/schemas/prepare.js ./packages/schemas/prepare.js
COPY --from=builder /app/packages/agent-tools/package.json ./packages/agent-tools/package.json
COPY --from=builder /app/packages/agent-tools/prepare.js ./packages/agent-tools/prepare.js

# Placeholder dist dirs so prepare hooks / package mains resolve during install
RUN mkdir -p packages/schemas/dist packages/agent-tools/dist

RUN pnpm install --prod --frozen-lockfile --filter api...

# Bake DuckDB extensions with the exact @duckdb/node-api binary just installed
# (same DuckDB version and linux_amd64 platform the server runs). Chat-with-app
# direct-GCS mode LOADs httpfs from here with auto-install off, so no Cloud Run
# instance downloads from extensions.duckdb.org. Cached until the lockfile or
# this one compiled file changes.
COPY --from=builder /app/api/dist/apps/duckdb-extensions.js ./api/dist/apps/duckdb-extensions.js
RUN node api/dist/apps/duckdb-extensions.js /opt/duckdb-extensions \
    && test -n "$(find /opt/duckdb-extensions -name 'httpfs.duckdb_extension')" \
    && rm -rf api/dist

# =============================================================================
# Production runtime
# =============================================================================
FROM node:24.22.1-bookworm-slim
WORKDIR /app

# Runtime packages only (no compilers):
# - python3 + python3-venv: run the dbt venvs copied below.
# - git: Apps keep a local clone of each linked GitHub repo as an ephemeral
#   read cache for the file explorer; node:*-slim ships without it (`spawn
#   git ENOENT` on app creation).
# - ca-certificates: chat-with-app reads parquet over DuckDB httpfs (HTTPS /
#   gs://) and the sandbox allow-lists the system CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dbt-venvs /opt/dbt /opt/dbt
COPY --from=dbt-venvs /opt/dbt-mysql /opt/dbt-mysql
ENV DBT_VENV_BIN=/opt/dbt/bin/dbt
ENV DBT_MYSQL_VENV_BIN=/opt/dbt-mysql/bin/dbt

ENV DUCKDB_EXTENSION_DIRECTORY=/opt/duckdb-extensions
COPY --from=prod-deps /opt/duckdb-extensions /opt/duckdb-extensions

# Installed workspace (root + per-package node_modules, symlinks intact)
COPY --from=prod-deps /app ./

# Copy compiled shared packages + app/API output
COPY --from=builder /app/packages/schemas/dist ./packages/schemas/dist
COPY --from=builder /app/packages/agent-tools/dist ./packages/agent-tools/dist
COPY --from=builder /app/api/dist ./api/dist
COPY --from=builder /app/app/dist ./api/public

# Run as the image's unprivileged `node` user. Code stays root-owned
# (read-only to the server); the only in-image write path is the filesystem
# artifact store's default (api/.data). Everything else goes to $HOME or
# the OS temp dir.
RUN mkdir -p /app/api/.data && chown node:node /app/api/.data
USER node
ENV HOME=/home/node

WORKDIR /app/api

ENV PORT=8080
EXPOSE 8080

ENV NODE_OPTIONS="--max-old-space-size=1024 --expose-gc"

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
