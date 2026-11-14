# Workflow runtime image: the only packages workspace workflow code can import.
# Built by .github/workflows/workflows-runtime-image.yml (dev + prod registries).
FROM node:24.22.1-slim
WORKDIR /runtime
COPY deploy/workflows/runtime/package.json ./
RUN npm install --omit=optional --no-audit --no-fund && npm cache clean --force
COPY deploy/workflows/runtime/entrypoint.mjs deploy/workflows/runtime/worker.mjs deploy/workflows/runtime/step.mjs deploy/workflows/runtime/build.mjs ./
COPY deploy/workflows/runtime/defaults ./defaults
# Root inside the gVisor sandbox, only to start each workflow's steps as
# that workflow's own user (worker.mjs). Workflow code never runs as root.
USER root
ENTRYPOINT ["node", "/runtime/entrypoint.mjs"]
