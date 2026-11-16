/**
 * The source hash: the one name a bundle has.
 *
 * Every input that can change the built file is in it: each file of the folder
 * (the lockfile included, and named explicitly so the intent is visible), the
 * `@makoai/connector-sdk` version the bundle is built against, and the build
 * recipe (esbuild version and options). A bundle is immutable and stored under
 * this hash, so anything left out here would let a changed input be served a
 * stale bundle.
 */
import { createHash } from "node:crypto";
import { LOCKFILE } from "./manifest";

/** esbuild version the build box installs. Part of the hash. */
export const BUNDLE_ESBUILD_VERSION = "0.25.12";

/**
 * Bumped whenever the build command changes in a way that changes output
 * (flags, banner, target). Part of the hash, so old bundles are never reused
 * for a new recipe.
 */
export const BUNDLE_RECIPE_VERSION = 1;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function bundleSourceHash(input: {
  files: ReadonlyMap<string, Uint8Array>;
  sdkVersion: string;
}): string {
  const { files, sdkVersion } = input;
  const hash = createHash("sha256");
  hash.update(`mako-connector-bundle\0recipe:${BUNDLE_RECIPE_VERSION}\0`);
  hash.update(`esbuild:${BUNDLE_ESBUILD_VERSION}\0`);
  hash.update(`sdk:${sdkVersion}\0`);
  const lock = files.get(LOCKFILE);
  hash.update(`lockfile:${lock ? sha256(lock) : "none"}\0`);
  for (const name of [...files.keys()].sort()) {
    hash.update(`file:${name}\0${sha256(files.get(name) as Uint8Array)}\0`);
  }
  return hash.digest("hex");
}
