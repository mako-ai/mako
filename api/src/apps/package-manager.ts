/**
 * Which package manager installs an app, decided by the app itself.
 *
 * Every app folder is its own npm-style project, and the lockfile it commits
 * says how it was resolved. Installing a `pnpm-lock.yaml` app with npm ignores
 * that lockfile (and writes a second, competing `package-lock.json`), so the
 * install command is chosen per app, in the sandbox, from what the folder
 * holds:
 *
 *   1. `pnpm-lock.yaml`                    → pnpm
 *   2. `"packageManager": "pnpm@…"`        → pnpm (a new app before its first
 *                                            install has no lockfile yet)
 *   3. anything else (`package-lock.json`,
 *      no lockfile at all)                 → npm, exactly as before
 *
 * pnpm wins when both lockfiles exist: an agent's habitual `npm install` in a
 * pnpm app leaves a stray `package-lock.json`, and that must not flip the app
 * back to npm.
 *
 * Why pnpm is preferred for new apps: one content-addressed store per box,
 * hard-linked into every app's `node_modules`, instead of a full copy of vite,
 * react and typescript per app — the publish box builds every app in the
 * workspace and filled its disk with exactly those copies.
 *
 * Both commands are shell, evaluated inside the app's folder in the sandbox:
 * the API host has no checkout to look at.
 */

/**
 * The pnpm the sandbox image installs, and the version new apps pin in
 * `packageManager` (corepack wants an exact version there).
 */
export const PNPM_VERSION = "10.33.3";

/** Shell test that succeeds when the app in the cwd is a pnpm app. */
export const IS_PNPM_APP = `{ [ -f pnpm-lock.yaml ] || grep -Eq '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@' package.json 2>/dev/null; }`;

/**
 * pnpm, or a pinned one through npx where the box has none (a self-hosted
 * local sandbox). The E2B template installs pnpm globally.
 */
const PNPM = `$(command -v pnpm >/dev/null 2>&1 && echo pnpm || echo "npx --yes pnpm@${PNPM_VERSION}")`;

/**
 * The install command for the app in the cwd.
 *
 * `verbose` streams progress for a client tailing the log: npm is near-silent
 * when its stdout is a pipe without `--loglevel=http`, and
 * `--foreground-scripts` shows lifecycle-script output. pnpm's
 * `append-only` reporter is the pipe-friendly equivalent.
 *
 * pnpm flags:
 * - `--no-frozen-lockfile`: match `npm install`, which reconciles a lockfile
 *   that is behind package.json instead of failing (pnpm turns frozen on by
 *   itself when it detects CI).
 * - `--config.confirmModulesPurge=false`: a `node_modules` that npm built is
 *   replaced without the interactive prompt, which has no TTY to answer it.
 */
export function installCommand(options: { verbose?: boolean } = {}): string {
  const npm = options.verbose
    ? "npm install --no-audit --no-fund --loglevel=http --foreground-scripts"
    : "npm install --no-audit --no-fund";
  const pnpm =
    `${PNPM} install --no-frozen-lockfile --config.confirmModulesPurge=false` +
    (options.verbose ? " --reporter=append-only" : "");
  return `if ${IS_PNPM_APP}; then ${pnpm}; else ${npm}; fi`;
}

/** Shell test that succeeds when the app in the cwd depends on a `@makoai/*` package. */
export const DEPENDS_ON_MAKO_PACKAGES = `grep -q '"@makoai/' package.json 2>/dev/null`;

/**
 * Move the app's `@makoai/*` dependencies to the newest release INSIDE the
 * range its package.json declares (`^2.7.0` → newest 2.x), after the install.
 *
 * Why: every app commits a lockfile, and a lockfile freezes a caret range at
 * whatever version it first resolved — 83 apps sat on SDK 2.4.0 while 2.6 was
 * out. Our own packages follow semver, so floating them inside the declared
 * range is what lets SDK fixes and the house style reach apps without a
 * per-app bump commit or a vendored copy. Third-party dependencies stay
 * exactly as locked.
 *
 * Best effort: a registry hiccup must not fail a deploy, so a failed update
 * is logged and the build uses the versions the install put there. The
 * box's lockfile change is never committed back.
 */
export function updateMakoPackagesCommand(): string {
  const names = `$(node -p "const p=require('./package.json');Object.keys({...p.dependencies,...p.devDependencies}).filter(n=>n.startsWith('@makoai/')).join(' ')")`;
  const pnpm = `${PNPM} update '@makoai/*' --config.confirmModulesPurge=false --reporter=append-only`;
  const npm = `npm update --no-audit --no-fund ${names}`;
  return (
    `if ${DEPENDS_ON_MAKO_PACKAGES}; then ` +
    `{ if ${IS_PNPM_APP}; then ${pnpm}; else ${npm}; fi; } || ` +
    `echo "mako: could not update @makoai packages; building with the installed versions"; fi`
  );
}

/**
 * Shell test that succeeds when `node_modules` is still current: our stamp
 * (written only after a successful install) is newer than package.json AND
 * than whichever lockfile the app commits — a lockfile-only change (a
 * dependency bump, an npm → pnpm switch) must reinstall too.
 */
export const INSTALL_IS_FRESH =
  `{ [ node_modules/.mako-installed -nt package.json ] && ` +
  `{ [ ! -f pnpm-lock.yaml ] || [ node_modules/.mako-installed -nt pnpm-lock.yaml ]; } && ` +
  `{ [ ! -f package-lock.json ] || [ node_modules/.mako-installed -nt package-lock.json ]; }; }`;
