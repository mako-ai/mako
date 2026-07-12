import { AppV2ValidationError } from "./errors";

const GIT_SEGMENT = ".git";
export const APP_V2_MAX_PATH_SEGMENTS = 64;

export function validateAppV2Path(candidate: string): string {
  if (!candidate || candidate.includes("\0")) {
    throw new AppV2ValidationError("Path must be a non-empty POSIX path");
  }
  if (candidate.includes("\\")) {
    throw new AppV2ValidationError("Backslashes are not allowed in paths");
  }
  if (candidate.startsWith("/")) {
    throw new AppV2ValidationError("Absolute paths are not allowed");
  }

  const segments = candidate.split("/");
  if (segments.length > APP_V2_MAX_PATH_SEGMENTS) {
    throw new AppV2ValidationError(
      `Paths may not exceed ${APP_V2_MAX_PATH_SEGMENTS} segments`,
    );
  }
  if (
    segments.some(
      segment =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === GIT_SEGMENT,
    )
  ) {
    throw new AppV2ValidationError(
      "Paths may not contain empty, dot, parent, or .git segments",
    );
  }

  return candidate;
}

export function assertNoAppV2CaseCollisions(paths: readonly string[]): void {
  const canonicalPaths = new Map<string, string>();
  for (const candidate of paths) {
    const validated = validateAppV2Path(candidate);
    const canonical = validated.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = canonicalPaths.get(canonical);
    if (existing && existing !== validated) {
      throw new AppV2ValidationError(
        `Path case collision between "${existing}" and "${validated}"`,
      );
    }
    canonicalPaths.set(canonical, validated);
  }

  for (const canonical of canonicalPaths.keys()) {
    const segments = canonical.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (canonicalPaths.has(segments.slice(0, index).join("/"))) {
        throw new AppV2ValidationError(
          "A file path may not also be used as a directory",
        );
      }
    }
  }
}
