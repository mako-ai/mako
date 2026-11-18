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
/** npm reads this file from the folder it installs in. It is refused. */
export const NPMRC = ".npmrc";
/**
 * npm prefers this lockfile over `package-lock.json` when both exist, so it
 * would install around the check below. It is refused.
 */
export const SHRINKWRAP = "npm-shrinkwrap.json";
/**
 * The one registry a build installs from. The build passes it to npm, and
 * every `resolved` URL in the lockfile has to start with it.
 */
export const NPM_REGISTRY = "https://registry.npmjs.org/";
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
  if (files.has(SHRINKWRAP)) {
    return {
      kind: "invalid",
      reason:
        `npm installs from ${SHRINKWRAP} ahead of ${LOCKFILE}, and Mako checks only ${LOCKFILE}. ` +
        `Remove ${SHRINKWRAP}, run npm install in the folder and commit ${LOCKFILE}.`,
    };
  }
  if (files.has(NPMRC)) {
    // npm ci reads the folder's .npmrc: it can move the registry, set a
    // proxy or turn off TLS checks. The build pins all of that itself.
    return {
      kind: "invalid",
      reason:
        `Mako installs connector dependencies from ${NPM_REGISTRY} with its own npm settings, ` +
        `so ${NPMRC} is not allowed in the folder. Remove ${NPMRC} and push.`,
    };
  }
  const manifest = parseJsonObject(files.get(PACKAGE_JSON), PACKAGE_JSON);
  if (typeof manifest === "string") {
    return { kind: "invalid", reason: manifest };
  }
  const lock = parseJsonObject(files.get(LOCKFILE), LOCKFILE);
  if (typeof lock === "string") return { kind: "invalid", reason: lock };
  const lockProblem = lockfileProblem(lock);
  if (lockProblem) return { kind: "invalid", reason: lockProblem };
  return { kind: "npm" };
}

/**
 * Does a folder that passed {@link dependencyPlan} as `npm` declare or install
 * anything?
 *
 * True when `package.json` (or the lockfile's root entry) declares a
 * non-empty `dependencies` or `optionalDependencies`, or when the lockfile
 * installs any package. A folder that ships `package.json` for its peer
 * dependency on the SDK alone (Close, for one) declares and installs nothing,
 * so it runs its TypeScript entry as it did before bundles existed, flag or
 * not. A stale lockfile next to declared dependencies still counts, so it
 * reaches `npm ci` and is refused there with the fix.
 */
export function hasDependencies(
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  const declares = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return ["dependencies", "optionalDependencies"].some(key => {
      const deps = record[key];
      return (
        !!deps &&
        typeof deps === "object" &&
        Object.keys(deps as object).length > 0
      );
    });
  };
  const manifest = parseJsonObject(files.get(PACKAGE_JSON), PACKAGE_JSON);
  if (typeof manifest === "string" || declares(manifest)) return true;
  const lock = parseJsonObject(files.get(LOCKFILE), LOCKFILE);
  if (typeof lock === "string") return true;
  const packages = lock.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    return true;
  }
  const entries = packages as Record<string, unknown>;
  return declares(entries[""]) || Object.keys(entries).some(key => key !== "");
}

function parseJsonObject(
  bytes: Uint8Array | undefined,
  name: string,
): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `${name} must be a JSON object.`;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    return `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Every package in the lockfile must come from the npm registry.
 *
 * `npm ci` fetches each entry from its `resolved` URL. Without this check a
 * lockfile could pull a git repository, a tarball from any host, or a
 * `file:`/`link:` path outside the folder.
 *
 * - Every entry needs a plain semver `version`. With no `resolved`, npm
 *   fetches `<name>@<version>`, and a version such as a URL or a git spec
 *   would be fetched from wherever it points.
 * - Every entry needs a `resolved` URL on the registry and an integrity
 *   hash, except a package shipped inside its parent (`inBundle`).
 * - An `inBundle` entry has no `resolved` of its own and sits under another
 *   package's `node_modules/`. A top-level one would be bundled by the
 *   project itself, and npm fetches that from its `resolved` URL.
 *
 * The returned string is the refusal, or null when the lockfile is fine.
 */
/** A plain semver version: no range, no URL, no git or file spec. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function lockfileProblem(lock: Record<string, unknown>): string | null {
  const version = lock.lockfileVersion;
  const packages = lock.packages;
  if (
    (version !== 2 && version !== 3) ||
    !packages ||
    typeof packages !== "object" ||
    Array.isArray(packages)
  ) {
    return (
      `${LOCKFILE} must be lockfileVersion 2 or 3. ` +
      `Run npm install with npm 7 or later in the folder and commit ${LOCKFILE}.`
    );
  }
  for (const [key, raw] of Object.entries(packages)) {
    if (key === "") continue;
    const entry = (raw ?? {}) as Record<string, unknown>;
    const fix = `Depend on a version published to ${NPM_REGISTRY}, run npm install and commit ${LOCKFILE}.`;
    if (
      !key.startsWith("node_modules/") ||
      key.split("/").includes("..") ||
      entry.link === true
    ) {
      return `${LOCKFILE} links "${key}" from a local path. ${fix}`;
    }
    const name = key.slice("node_modules/".length);
    if (typeof entry.version !== "string" || !SEMVER.test(entry.version)) {
      return `${LOCKFILE} gives "${name}" the version ${JSON.stringify(entry.version)}, which is not a published version. ${fix}`;
    }
    const resolved = entry.resolved;
    if (entry.inBundle === true) {
      if (resolved !== undefined || !name.includes("/node_modules/")) {
        return `${LOCKFILE} marks "${name}" as bundled inside another package, but npm would fetch it on its own. ${fix}`;
      }
      continue;
    }
    if (typeof resolved !== "string" || !resolved.startsWith(NPM_REGISTRY)) {
      return `${LOCKFILE} installs "${name}" from ${resolved === undefined ? "no URL" : String(resolved)}. ${fix}`;
    }
    if (typeof entry.integrity !== "string" || !entry.integrity) {
      return `${LOCKFILE} has no integrity hash for "${name}". ${fix}`;
    }
  }
  return null;
}
