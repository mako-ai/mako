/* eslint-disable no-console, no-process-exit */
/**
 * Reproducible E2B template for Apps v2 tenant execution (adopted from the
 * parallel apps-v2 branch, adapted to this provider's session model).
 *
 * Improvements over the stock "base" template:
 * - pnpm preinstalled at a pinned version (alongside node/npm from base).
 * - The scaffold's npm dependency set pre-warmed into the npm cache, so a
 *   DEAD-sandbox rebuild's `npm install` is a cache hit instead of a cold
 *   registry crawl (the worst-case resume path).
 * - The session working root pre-created.
 *
 * Build: `pnpm --filter api run apps-v2:build-template` (needs E2B_API_KEY).
 * Then set APPS_V2_E2B_TEMPLATE=mako-apps-v2 (also the default alias).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Template } from "e2b";
import { createAppsV2Scaffold } from "./scaffold";

const DEFAULT_ALIAS = "mako-apps-v2";
const PNPM_VERSION = "10.33.3";

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

export function createAppsV2E2BTemplate() {
  // Warm the npm cache with the exact dependency set new apps scaffold with.
  const scaffoldPkg = createAppsV2Scaffold({ title: "warmup" })["package.json"];
  const pkgB64 = Buffer.from(scaffoldPkg, "utf8").toString("base64");

  return Template()
    .fromBaseImage()
    .runCmd(
      [
        "set -eux",
        "command -v node >/dev/null",
        "command -v git >/dev/null",
        `npm install -g --force pnpm@${PNPM_VERSION}`,
        `test "$(pnpm --version)" = "${PNPM_VERSION}"`,
        "mkdir -p /home/user/app",
        "chown -R user:user /home/user/app",
      ].join(" && "),
      { user: "root" },
    )
    .runCmd(
      [
        "set -eux",
        "mkdir -p /tmp/warmup",
        `echo ${pkgB64} | base64 -d > /tmp/warmup/package.json`,
        "cd /tmp/warmup && npm install --no-audit --no-fund",
        "rm -rf /tmp/warmup",
      ].join(" && "),
      { user: "user" },
    )
    .setWorkdir("/home/user/app")
    .setUser("user");
}

async function main(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is required");

  const alias = process.env.E2B_TEMPLATE_ALIAS?.trim() || DEFAULT_ALIAS;
  const build = await Template.build(createAppsV2E2BTemplate(), alias, {
    apiKey,
    cpuCount: 2,
    memoryMB: 2048,
  });

  // Identifiers only — the API key is never logged.
  console.log(
    JSON.stringify({
      alias: build.name,
      templateId: build.templateId,
      buildId: build.buildId,
    }),
  );
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
