#!/usr/bin/env node
// Thin launcher so `pnpm --filter @mako/local-agent exec mako-agent` (or a
// future packaged binary) starts the agent. Uses tsx to run TypeScript
// sources directly, mirroring how the api package runs in production.
require("tsx/cjs");
require("../src/index.ts");
