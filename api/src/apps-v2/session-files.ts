import { validateAppV2Path } from "./path-validation";

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".vite",
  "coverage",
]);

export function isAppV2SessionFileEligible(candidate: string): boolean {
  const filePath = validateAppV2Path(candidate);
  const segments = filePath.split("/");
  return !segments.some(
    segment =>
      EXCLUDED_SEGMENTS.has(segment.toLocaleLowerCase("en-US")) ||
      segment.toLocaleLowerCase("en-US").startsWith(".env"),
  );
}

export function normalizeSandboxFilePath(candidate: string): string {
  const prefix = "/workspace/";
  if (candidate.startsWith(prefix)) {
    return validateAppV2Path(candidate.slice(prefix.length));
  }
  if (candidate.startsWith("/")) {
    throw new Error("Sandbox file is outside /workspace");
  }
  return validateAppV2Path(candidate);
}
