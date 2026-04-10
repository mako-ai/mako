# Just build everything in one go
FROM node:20 AS builder
WORKDIR /app

# Install pnpm first (this layer will be cached)
RUN npm install -g pnpm

# Copy everything
COPY . .

# Install all dependencies (workspace handles conflicts)
RUN pnpm install

# Build shared packages first, then apps
RUN pnpm --filter @mako/schemas run build
RUN pnpm run app:build
RUN pnpm run api:build

# Production stage
FROM node:20-slim
WORKDIR /app

# Install build tools needed for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

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
COPY --from=builder /app/packages/schemas/dist ./packages/schemas/dist

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
