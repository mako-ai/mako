/**
 * The workflow runtime a sandbox needs to run a workflow
 * (deploy/workflows/runtime, the same files the worker image is built from,
 * and the CLI's `mako workflow run` files in cli/), and the shell that puts
 * it in a box. Installed on demand and by content:
 * a box made before workflows existed, or holding an older runtime, gets the
 * current one on its next sandbox run. The sandbox image carries it already
 * installed (e2b-template.ts), which only makes the first run faster.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILES = [
  "package.json",
  "run.mjs",
  "defaults/hatchet.ts",
  "defaults/lib/mako.ts",
];

/** `mako workflow run` itself (packages/cli), run by run.mjs in the box. */
const CLI_FILES = [
  "workflow.js",
  "workflow-runner.js",
  "workflow-loader.js",
  "workflow-hatchet.js",
];

/** Where the runtime lives in a box: the box user's own folder. */
export const RUNTIME_IN_BOX = "$HOME/.mako-workflows";

/** Built, the files sit next to this module (api's build copies them). */
const sourceDir = () =>
  [
    path.join(__dirname, "runtime"),
    path.resolve(__dirname, "../../../deploy/workflows/runtime"),
  ].find(dir => fs.existsSync(path.join(dir, "run.mjs"))) ?? "";

/** Built, in the runtime's cli/; in the repository, the CLI's own src/. */
const cliDir = () =>
  [
    path.join(__dirname, "runtime", "cli"),
    path.resolve(__dirname, "../../../packages/cli/src"),
  ].find(dir => fs.existsSync(path.join(dir, "workflow.js"))) ?? "";

/** Shell that makes the box's runtime the current one; a no-op when it is. */
export function installRuntimeCommand(): string {
  const dir = sourceDir();
  const cli = cliDir();
  const files = [
    ...FILES.map(file => ({
      file,
      content: fs.readFileSync(path.join(dir, file)),
    })),
    ...CLI_FILES.map(file => ({
      file: `cli/${file}`,
      content: fs.readFileSync(path.join(cli, file)),
    })),
  ];
  const hash = createHash("sha256");
  for (const { file, content } of files) hash.update(file).update(content);
  const version = hash.digest("hex").slice(0, 16);
  const to = RUNTIME_IN_BOX;
  return [
    `if [ "$(cat "${to}/.version" 2>/dev/null)" != ${version} ]; then`,
    `mkdir -p "${to}/defaults/lib" "${to}/cli"`,
    ...files.map(
      ({ file, content }) =>
        `&& echo ${content.toString("base64")} | base64 -d > "${to}/${file}"`,
    ),
    `&& (cd "${to}" && npm install --no-audit --no-fund)`,
    `&& echo ${version} > "${to}/.version"; fi`,
  ].join(" ");
}
