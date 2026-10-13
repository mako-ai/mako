/**
 * The workflow runtime a sandbox needs to run a workflow
 * (deploy/workflows/runtime, the same files the worker image is built from),
 * and the shell that puts it in a box. Installed on demand and by content:
 * a box made before workflows existed, or holding an older runtime, gets the
 * current one on its next sandbox run. The sandbox image carries it already
 * installed (e2b-template.ts), which only makes the first run faster.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILES = [
  "package.json",
  "build.mjs",
  "run.mjs",
  "worker.mjs",
  "defaults/hatchet.ts",
  "defaults/lib/mako.ts",
];

/** Where the runtime lives in a box: the box user's own folder. */
export const RUNTIME_IN_BOX = "$HOME/.mako-workflows";

/** Built, the files sit next to this module (api's build copies them). */
const sourceDir = () =>
  [
    path.join(__dirname, "runtime"),
    path.resolve(__dirname, "../../../deploy/workflows/runtime"),
  ].find(dir => fs.existsSync(path.join(dir, "run.mjs"))) ?? "";

/** Shell that makes the box's runtime the current one; a no-op when it is. */
export function installRuntimeCommand(): string {
  const dir = sourceDir();
  const files = FILES.map(file => ({
    file,
    content: fs.readFileSync(path.join(dir, file)),
  }));
  const hash = createHash("sha256");
  for (const { file, content } of files) hash.update(file).update(content);
  const version = hash.digest("hex").slice(0, 16);
  const to = RUNTIME_IN_BOX;
  return [
    `if [ "$(cat "${to}/.version" 2>/dev/null)" != ${version} ]; then`,
    `mkdir -p "${to}/defaults/lib"`,
    ...files.map(
      ({ file, content }) =>
        `&& echo ${content.toString("base64")} | base64 -d > "${to}/${file}"`,
    ),
    `&& (cd "${to}" && npm install --no-audit --no-fund)`,
    `&& echo ${version} > "${to}/.version"; fi`,
  ].join(" ");
}
