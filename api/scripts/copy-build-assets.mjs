#!/usr/bin/env node
// Copies the non-TypeScript files `api/dist` needs at runtime, after tsc.
// Run from anywhere; paths resolve from this file. Replaces the old
// copyfiles + inline `node -e` chain in the api `build` script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(apiDir, "..");
const dist = path.join(apiDir, "dist");

/** Every file under `dir` (relative paths), skipping dotfiles and node_modules. */
function walk(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

let copied = 0;
const copy = (from, to) => {
  copyFile(from, to);
  copied++;
};

// 1. Assets that live next to the source: icons, skill markdown, Python.
//    src/<path> -> dist/<path>
const src = path.join(apiDir, "src");
for (const rel of walk(src)) {
  const isAsset =
    rel.endsWith(".svg") ||
    rel.endsWith(".py") ||
    (rel.startsWith(`agent-skills${path.sep}`) && rel.endsWith(".md"));
  if (isAsset) copy(path.join(src, rel), path.join(dist, rel));
}

// 2. The app SDK, served to sandboxes as a flat package: dist/app-sdk/<file>
const appSdk = path.join(repoDir, "packages/app-sdk");
for (const f of [
  "package.json",
  "index.js",
  "index.d.ts",
  "vite.js",
  "vite.d.ts",
  "credentials.js",
  "credentials.d.ts",
  "README.md",
]) {
  copy(path.join(appSdk, f), path.join(dist, "app-sdk", f));
}

// 3. The connector SDK: dist/connector-sdk/{package.json,index.*,src/**,bin/**}
const connectorSdk = path.join(repoDir, "packages/connector-sdk");
for (const f of ["package.json", "index.js", "index.d.ts"]) {
  copy(path.join(connectorSdk, f), path.join(dist, "connector-sdk", f));
}
for (const sub of ["src", "bin"]) {
  for (const rel of walk(path.join(connectorSdk, sub))) {
    copy(
      path.join(connectorSdk, sub, rel),
      path.join(dist, "connector-sdk", sub, rel),
    );
  }
}

// 4. The workflows runtime (minus node_modules), plus the CLI's workflow
//    loader/runner it imports: dist/workflows/runtime/{...,cli/*}
fs.cpSync(
  path.join(repoDir, "deploy/workflows/runtime"),
  path.join(dist, "workflows/runtime"),
  { recursive: true, filter: p => !p.includes("node_modules") },
);
for (const f of [
  "workflow.js",
  "workflow-runner.js",
  "workflow-loader.js",
  "workflow-hatchet.js",
]) {
  copy(
    path.join(repoDir, "packages/cli/src", f),
    path.join(dist, "workflows/runtime/cli", f),
  );
}

console.log(`copy-build-assets: ${copied} files + workflows runtime -> dist`);
