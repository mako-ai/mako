import { AppV2ValidationError } from "./errors";
import { validateAppV2Path } from "./path-validation";

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const INVALID_REF_CHARACTERS = /[~^:?*[\]\\]/;

function hasControlOrSpace(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

export function validateGitHubOwner(value: string): string {
  const normalized = value.trim();
  if (!GITHUB_OWNER_PATTERN.test(normalized)) {
    throw new AppV2ValidationError("Invalid GitHub repository owner");
  }
  return normalized;
}

export function validateGitHubRepository(value: string): string {
  const normalized = value.trim();
  if (
    !GITHUB_REPOSITORY_PATTERN.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new AppV2ValidationError("Invalid GitHub repository name");
  }
  return normalized;
}

export function validateGitHubRef(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    normalized === "@" ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.includes("//") ||
    hasControlOrSpace(normalized) ||
    INVALID_REF_CHARACTERS.test(normalized) ||
    normalized.split("/").some(segment => {
      return !segment || segment.startsWith(".") || segment.endsWith(".lock");
    })
  ) {
    throw new AppV2ValidationError("Invalid GitHub branch");
  }
  return normalized;
}

export function normalizeGitHubSubdirectory(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) return undefined;
  if (normalized.length > 512) {
    throw new AppV2ValidationError("Invalid GitHub subdirectory");
  }
  return validateAppV2Path(normalized);
}
