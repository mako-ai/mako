/* eslint-disable no-console, no-process-exit */
/**
 * Reproducible E2B template for Apps tenant execution (adopted from the
 * parallel apps branch, adapted to this provider's session model).
 *
 * Improvements over the stock "base" template:
 * - pnpm preinstalled at a pinned version (alongside node/npm from base).
 * - The scaffold's npm dependency set pre-warmed into the npm cache, so a
 *   DEAD-sandbox rebuild's `npm install` is a cache hit instead of a cold
 *   registry crawl (the worst-case resume path).
 * - The session working root pre-created.
 *
 * Build: `pnpm --filter api run apps:build-template` (needs E2B_API_KEY).
 * Then set APPS_E2B_TEMPLATE=mako-apps (also the default alias).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Template } from "e2b";
import { createAppsScaffold } from "./scaffold";

const DEFAULT_ALIAS = "mako-apps";
const PNPM_VERSION = "10.33.3";

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

/**
 * The interactive shell config, written into the image as `~/.bashrc`.
 *
 * The terminal is bash, and it is bash for a measured reason. Same 100KB
 * payload, same sandbox, time until the shell is usable again:
 *
 *   shell                     typed   pasted   one 100KB line   (bracketed)
 *   bash                      3.0s    2.4s     2.0s             1.9s
 *   zsh, this config in zsh   2.9s    2.9s     WEDGED           2.0s
 *   zsh + autosuggest/highlt  WEDGED  WEDGED   —                —
 *   zsh + Oh My Zsh           WEDGED  WEDGED   —                —
 *
 * bash never wedged in any configuration tried. zsh survives an enormous
 * single-line paste only when the client wraps it in bracketed-paste markers,
 * because zle's redraw of one very long line is quadratic; readline's is not.
 * Any line-editor plugin (Oh My Zsh included, via `lib/misc.zsh` binding
 * url-quote-magic to self-insert) makes it far worse by running a shell
 * function over the whole buffer on EVERY keystroke — while it works the pty
 * stops reading, so writes to it block and the terminal appears to freeze.
 *
 * bash is also the shell the agent's `exec` path already uses, so there is one
 * shell's behaviour to reason about rather than two that drift. zsh stays
 * installed for anyone who prefers it — `zsh` starts it, and ~/.zshrc below is
 * a reasonable starting point — it is just not what the terminal opens.
 *
 * Everything here runs once per shell or once per prompt, never per keystroke.
 */
const BASHRC = [
  "# Managed by Mako (api/src/apps/e2b-template.ts). Yours to edit — but a",
  "# rebuilt sandbox starts from this file again.",
  "case $- in *i*) ;; *) return ;; esac",
  "",
  "# Branch in the prompt, computed once per prompt rather than by anything",
  "# that runs while you type.",
  "__mako_branch() {",
  "  local b",
  "  b=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || return",
  "  printf ' \\001\\033[33m\\002%s\\001\\033[0m\\002' \"$b\"",
  "}",
  "# \\[ \\] around colours so bash knows they take no width; without them the",
  "# cursor lands in the wrong place as soon as a line wraps.",
  "PS1='\\[\\033[32m\\]\\W\\[\\033[0m\\]$(__mako_branch) \\[\\033[36m\\]\\$\\[\\033[0m\\] '",
  "",
  "HISTSIZE=10000",
  "HISTFILESIZE=20000",
  "HISTCONTROL=ignoreboth",
  "# Append rather than overwrite, so two terminals do not lose each other's",
  "# history.",
  "shopt -s histappend checkwinsize cdspell",
  "PROMPT_COMMAND='history -a'",
  "",
  "# Bracketed paste, set explicitly rather than trusted to the default.",
  "# It is what lets a large paste arrive as one insert instead of N",
  "# keystrokes — the difference between a 1MB paste taking seconds and",
  "# locking the terminal — and it stops a pasted multi-line block from",
  "# running itself line by line before you have read it.",
  "bind 'set enable-bracketed-paste on' 2>/dev/null",
  "",
  "# Search history by what is already typed.",
  "bind '\"\\e[A\": history-search-backward' 2>/dev/null",
  "bind '\"\\e[B\": history-search-forward' 2>/dev/null",
  "",
  "[ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion",
  "",
  "alias ls='ls --color=auto'",
  "alias ll='ls -lah --color=auto'",
  "alias grep='grep --color=auto'",
  "export LESS=-R",
  'export EDITOR="${EDITOR:-nano}"',
  "# Deliberately no `cd`: the terminal is opened in the app's own folder, and",
  "# a cd here would silently override it.",
].join("\n");

/** Kept for anyone who prefers zsh; `zsh` starts it. Not the login shell. */
export const ZSHRC = [
  "# Managed by Mako (api/src/apps/e2b-template.ts). Not the login shell —",
  "# run `zsh` to use it. Deliberately free of line-editor plugins: anything",
  "# that wraps self-insert runs over the whole buffer on every keystroke and",
  "# freezes the terminal on a large paste.",
  "autoload -Uz compinit && compinit -C",
  "zstyle ':completion:*' menu select",
  "zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'",
  "zstyle ':completion:*' list-colors \"${(s.:.)LS_COLORS}\"",
  "",
  "autoload -Uz vcs_info",
  "zstyle ':vcs_info:git:*' formats ' %F{yellow}%b%f'",
  "zstyle ':vcs_info:git:*' actionformats ' %F{yellow}%b%f %F{red}%a%f'",
  "precmd() { vcs_info }",
  "setopt PROMPT_SUBST",
  "PROMPT='%F{green}%1~%f${vcs_info_msg_0_} %(?..%F{red}%?%f )%F{cyan}❯%f '",
  "PROMPT_EOL_MARK=''",
  "",
  "HISTFILE=~/.zsh_history",
  "HISTSIZE=10000",
  "SAVEHIST=10000",
  "setopt SHARE_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE INC_APPEND_HISTORY",
  "setopt AUTO_CD INTERACTIVE_COMMENTS NO_BEEP",
  "",
  "bindkey -e",
  "autoload -Uz up-line-or-beginning-search down-line-or-beginning-search",
  "zle -N up-line-or-beginning-search",
  "zle -N down-line-or-beginning-search",
  "bindkey '^[[A' up-line-or-beginning-search",
  "bindkey '^[[B' down-line-or-beginning-search",
  "",
  "alias ls='ls --color=auto'",
  "alias ll='ls -lah --color=auto'",
  "alias grep='grep --color=auto'",
  "export LESS=-R",
].join("\n");

/** Plant a file without letting its content meet the shell's parser. */
const b64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

export function createAppsE2BTemplate() {
  // Warm the npm cache with the exact dependency set new apps scaffold with.
  const scaffoldPkg = createAppsScaffold({ title: "warmup" })["package.json"];

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
        // An editor is not a luxury here: `git commit` with no -m opens one,
        // and the image shipped without vi, vim or nano, so it failed with a
        // confusing error. vim-tiny provides /usr/bin/vi for muscle memory and
        // nano for everyone else; together they are a couple of MB.
        // dtach + tmux make sessions durable, with different jobs: dtach is
        // the INTERACTIVE session keeper — a pure socket relay with no
        // screen engine, so xterm.js sees a linear byte stream and its own
        // native scrollback and wheel work (tmux's redraw engine and a
        // browser terminal fight over scrolling; see terminal-ws). tmux
        // remains for HEADLESS sessions (per-app dev servers), where its
        // attachability is pure upside. script(1) ships in util-linux and
        // records interactive sessions for reattach history.
        "if ! command -v zsh >/dev/null || ! command -v vi >/dev/null || ! command -v tmux >/dev/null || ! command -v dtach >/dev/null; then " +
          "(apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zsh vim-tiny nano bash-completion ca-certificates tmux dtach && rm -rf /var/lib/apt/lists/*) " +
          "|| (apk add --no-cache zsh vim nano bash-completion ca-certificates tmux dtach) " +
          "|| (yum install -y zsh vim-minimal nano bash-completion ca-certificates tmux dtach); fi",
        "zsh --version",
        "command -v tmux",
        "command -v dtach",
        "command -v script",
        // Prove the editor is really there, rather than discovering it the
        // first time someone runs `git commit`.
        "command -v vi",
        "command -v nano",
        // bash is the login shell (see the note on BASHRC); zsh is available
        // for anyone who runs it.
        'chsh -s "$(command -v bash)" user',
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
        // No pager. git pipes into `less` by default, and this terminal
        // outlives the socket watching it: one `git log` leaves the shell
        // sitting in a pager, and the NEXT person to open the terminal lands
        // inside it with no idea why — the scrollback replay faithfully
        // redraws the pager screen for them.
        "git config --global core.pager cat",
        "git config --global init.defaultBranch main",
      ].join(" && "),
      { user: "user" },
    )
    .runCmd(
      [
        "set -eux",
        // Install the shell config as ONE fragment: these commands are joined
        // with `&&`, and a heredoc body has to sit on its own lines.
        // base64 rather than a heredoc, and not by preference: these commands
        // are joined with ` && `, which lands the terminator on a line reading
        // `MAKO_BASHRC && printf ...`. That is not a terminator, so the
        // heredoc ran to end-of-file and swallowed the whole rest of the
        // script — including the checks meant to catch it, which is why the
        // build still passed while .bash_profile and .zshrc were never
        // created. base64 has no such interaction with the join, and is
        // already how package.json is planted below.
        `echo ${b64(BASHRC)} | base64 -d > /home/user/.bashrc`,
        // A login bash reads .bash_profile and then stops, so without this the
        // terminal would open with none of the config above.
        `echo ${b64("[ -f ~/.bashrc ] && . ~/.bashrc\n")} | base64 -d > /home/user/.bash_profile`,
        `echo ${b64(ZSHRC)} | base64 -d > /home/user/.zshrc`,
        // Fail the build rather than ship a template whose shell quietly fell
        // back to defaults. Each file's exact byte count is checked, not just
        // that some marker is present: the heredoc bug this replaced left a
        // .bashrc that still contained every marker AND the rest of the build
        // script, and passed a grep-based check happily.
        // Byte length, not String#length: both files contain em dashes and a
        // ❯, and `wc -c` counts bytes.
        `test "$(wc -c < /home/user/.bashrc)" = ${Buffer.byteLength(BASHRC, "utf8")}`,
        `test "$(wc -c < /home/user/.zshrc)" = ${Buffer.byteLength(ZSHRC, "utf8")}`,
        "test -s /home/user/.bash_profile",
        // And prove each shell actually starts with the config it was given.
        "bash -ic 'exit'",
        "zsh -ic 'exit'",
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
  const build = await Template.build(createAppsE2BTemplate(), alias, {
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
