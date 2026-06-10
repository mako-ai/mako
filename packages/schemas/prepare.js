// Cross-platform prepare hook: compile with tsc when TypeScript is installed
// (it isn't in production installs, e.g. `pnpm install --prod`, where the
// pre-built dist/ is shipped instead). Replaces the previous POSIX-only
// `command -v tsc` check, which fails on Windows runners.
const { spawnSync } = require("child_process");

let tscPath;
try {
  tscPath = require.resolve("typescript/bin/tsc");
} catch {
  process.exit(0);
}

const result = spawnSync(process.execPath, [tscPath], {
  stdio: "inherit",
  cwd: __dirname,
});
process.exit(result.status ?? 0);
