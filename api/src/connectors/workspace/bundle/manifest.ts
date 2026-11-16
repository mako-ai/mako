/**
 * What a connector folder says about its dependencies, read without running
 * anything.
 *
 * One lockfile format is accepted: `package-lock.json`. npm ships inside the
 * Node tarball the sync runtime already pins, so the build box needs no second
 * package manager, and `npm ci` refuses a lockfile that disagrees with
 * `package.json` instead of quietly resolving something new. A pnpm or yarn
 * lockfile is refused with the command that produces the accepted one.
 */

export const PACKAGE_JSON = "package.json";
export const LOCKFILE = "package-lock.json";
const OTHER_LOCKFILES = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
];

/** The first path inside a `node_modules/` directory, or null. */
export function findNodeModules(paths: Iterable<string>): string | null {
  for (const candidate of paths) {
    if (candidate.split("/").includes("node_modules")) return candidate;
  }
  return null;
}

/** The refusal shown for a folder that committed its `node_modules/`. */
export function nodeModulesRefusal(slug: string): string {
  return (
    `connectors/${slug}/ contains node_modules/. Mako installs dependencies itself from ` +
    `package.json and package-lock.json, so node_modules/ must not be committed. Fix: ` +
    `git rm -r --cached connectors/${slug}/node_modules, add node_modules/ to .gitignore, ` +
    `commit package.json with package-lock.json (run npm install in the folder to create it), and push.`
  );
}

export type DependencyPlan =
  { kind: "none" } | { kind: "npm" } | { kind: "invalid"; reason: string };

/**
 * Does this folder need a build, and can it have one?
 *
 * No `package.json` means no dependencies: the folder runs as today. A
 * `package.json` needs `package-lock.json` next to it, because a build that
 * resolves versions at build time is not reproducible from its hash.
 */
export function dependencyPlan(
  files: ReadonlyMap<string, Uint8Array>,
): DependencyPlan {
  const other = OTHER_LOCKFILES.find(name => files.has(name));
  if (!files.has(PACKAGE_JSON)) {
    if (files.has(LOCKFILE) || other) {
      return {
        kind: "invalid",
        reason: `The folder has a lockfile but no ${PACKAGE_JSON}. Commit both, or neither.`,
      };
    }
    return { kind: "none" };
  }
  if (other && !files.has(LOCKFILE)) {
    return {
      kind: "invalid",
      reason:
        `Mako builds connector dependencies with npm and needs ${LOCKFILE}; found ${other}. ` +
        `Run npm install in the folder, commit ${LOCKFILE} and remove ${other}.`,
    };
  }
  if (!files.has(LOCKFILE)) {
    return {
      kind: "invalid",
      reason:
        `${PACKAGE_JSON} needs a ${LOCKFILE} next to it so the build is reproducible. ` +
        `Run npm install in the folder and commit ${LOCKFILE}.`,
    };
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(files.get(PACKAGE_JSON)),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "invalid",
        reason: `${PACKAGE_JSON} must be a JSON object.`,
      };
    }
  } catch (error) {
    return {
      kind: "invalid",
      reason: `${PACKAGE_JSON} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { kind: "npm" };
}
