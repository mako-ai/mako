const MAX_ARG_COUNT = 64;
const MAX_ARG_CHARACTERS = 8_192;
const MAX_PACKAGE_COUNT = 32;
const MAX_PACKAGE_SPEC_CHARACTERS = 256;
const PACKAGE_SPEC =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9*^~<>=|._+-]+)?$/;

export function buildAppV2CommandArgv(
  executable: string,
  argumentLines: string,
): string[] {
  const command = executable.trim();
  const args = argumentLines
    .split("\n")
    .map(argument => argument.replace(/\r$/, ""))
    .filter(argument => argument.length > 0);
  const argv = [command, ...args];
  if (
    !command ||
    argv.length > MAX_ARG_COUNT ||
    argv.some(argument => argument.includes("\0")) ||
    argv.reduce((total, argument) => total + argument.length, 0) >
      MAX_ARG_CHARACTERS
  ) {
    throw new Error("Enter a valid executable and at most 63 arguments");
  }
  return argv;
}

export function parseAppV2PackageList(
  input: string,
): { packages: string[]; error: null } | { packages: []; error: string } {
  const packages = input
    .split("\n")
    .map(spec => spec.trim())
    .filter(Boolean);
  if (packages.length === 0) {
    return { packages: [], error: "Enter at least one package" };
  }
  if (packages.length > MAX_PACKAGE_COUNT) {
    return {
      packages: [],
      error: `Enter at most ${MAX_PACKAGE_COUNT} packages`,
    };
  }
  const invalid = packages.find(
    spec =>
      spec.length > MAX_PACKAGE_SPEC_CHARACTERS || !PACKAGE_SPEC.test(spec),
  );
  if (invalid) {
    return {
      packages: [],
      error: `"${invalid}" is not a valid npm registry package spec`,
    };
  }
  return { packages, error: null };
}
