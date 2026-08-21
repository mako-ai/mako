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
        // ALL git runs inside the sandbox (the API host has no git and never
        // shells out to it). Guarantee git is present — install it if the base
        // image lacks it — then assert.
        "if ! command -v git >/dev/null; then " +
          "(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*) " +
          "|| (apk add --no-cache git) " +
          "|| (yum install -y git); fi",
        "git --version",
        `npm install -g --force pnpm@${PNPM_VERSION}`,
        `test "$(pnpm --version)" = "${PNPM_VERSION}"`,
        // zsh for the interactive terminal. The PTY starts the user's login
        // shell, so this is what a person actually gets when they open one.
        "if ! command -v zsh >/dev/null; then " +
          "(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zsh ca-certificates && rm -rf /var/lib/apt/lists/*) " +
          "|| (apk add --no-cache zsh ca-certificates) " +
          "|| (yum install -y zsh ca-certificates); fi",
        "zsh --version",
        'chsh -s "$(command -v zsh)" user',
        "mkdir -p /home/user/app",
        "chown -R user:user /home/user/app",
      ].join(" && "),
      { user: "root" },
    )
    .runCmd(
      [
        "set -eux",
        // A default commit identity so `git commit` works without per-command
        // config (the server overrides author/committer per commit anyway).
        'git config --global user.name "Mako Agent"',
        'git config --global user.email "agent@mako.ai"',
        // Never block on an interactive credential/host prompt; the server
        // injects a tokenized remote URL for private repos.
        "git config --global credential.helper ''",
        "git config --global advice.detachedHead false",
        "git config --global init.defaultBranch main",
      ].join(" && "),
      { user: "user" },
    )
    .runCmd(
      [
        "set -eux",
        // Oh My Zsh, unattended. Kept deliberately small: the default
        // robbyrussell theme already shows the git branch and whether the
        // tree is dirty, which is the thing you actually want to see while
        // working, and every plugin is startup cost paid on every shell.
        'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended',
        // The two external plugins worth their weight: suggestions from
        // history as you type, and syntax highlighting that shows a typo'd
        // command in red BEFORE you run it.
        "git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions " +
          "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-autosuggestions",
        "git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting " +
          "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting",
        // `z` ships with Oh My Zsh and is the one navigation plugin people
        // genuinely miss. Syntax highlighting must be last — it wraps the
        // widgets the others install.
        "sed -i 's/^plugins=(.*)$/plugins=(git z zsh-autosuggestions zsh-syntax-highlighting)/' /home/user/.zshrc",
        // Deliberately NOT setting DISABLE_UNTRACKED_FILES_DIRTY: skipping
        // untracked files makes the prompt faster, but it also means creating
        // a new file leaves the prompt saying "clean", and creating files is
        // most of what happens here. A workspace repo is a handful of app
        // folders, not a monorepo, so the scan is cheap.
        // zsh prints a reverse-video "%" whenever output does not end in a
        // newline, which is most command output in practice — it looks like
        // corruption in a fresh terminal.
        "echo \"PROMPT_EOL_MARK=''\" >> /home/user/.zshrc",
        // Deliberately NOT cd-ing anywhere here: the PTY is opened in the
        // app's own folder, and a cd in .zshrc silently overrides it, landing
        // every terminal in the repo root instead of the app you opened.
        // Fail the build if the config did not take, rather than shipping a
        // template whose shell silently falls back to defaults.
        "grep -q 'zsh-syntax-highlighting' /home/user/.zshrc",
      ].join(" && "),
      { user: "user" },
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
