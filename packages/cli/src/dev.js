// `mako dev [app]` — run an app's dev server locally. Thin on purpose: data
// comes from the makoData() plugin in the app's vite.config.ts; this only
// picks the app, makes sure it is installed, passes the host, and runs it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { findCredential } from "@mako/app-sdk/credentials";
import { resolveAppDir } from "./context.js";

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
}

export async function dev(ctx, args, flags, io = { log: console.log }) {
  const appDir = resolveAppDir(ctx.repoRoot, args[0]);
  const slug = path.basename(appDir);
  if (!ctx.apiKey && !findCredential(ctx.apiUrl, ctx.workspaceId)) {
    io.log(`Not signed in to ${ctx.apiUrl} — bindings will answer 503. Run \`mako login\` first.`);
  }
  if (!fs.existsSync(path.join(appDir, "node_modules"))) {
    io.log(`Installing apps/${slug}…`);
    const code = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir });
    if (code !== 0) return code;
  }
  const port = flags.port ? String(flags.port) : null;
  const viteArgs = ["run", "dev", "--"];
  if (port) viteArgs.push("--port", port, "--strictPort");
  if (flags.open) viteArgs.push("--open");
  io.log(`apps/${slug} → vite dev${port ? ` on :${port}` : ""} (data via ${ctx.apiUrl})`);
  return run("npm", viteArgs, {
    cwd: appDir,
    env: { ...process.env, MAKO_API_URL: ctx.apiUrl, ...(ctx.workspaceId ? { MAKO_WORKSPACE_ID: ctx.workspaceId } : {}) },
  });
}
