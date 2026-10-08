# Workflow runtime image: the only packages workspace workflow code can import.
# Built by .github/workflows/workflows-runtime-image.yml (dev + prod registries).
FROM node:20-slim
WORKDIR /runtime
COPY deploy/workflows/runtime/package.json ./
RUN npm install --omit=optional --no-audit --no-fund && npm cache clean --force
COPY deploy/workflows/runtime/entrypoint.mjs deploy/workflows/runtime/worker.mjs ./
USER node
ENTRYPOINT ["node", "/runtime/entrypoint.mjs"]
