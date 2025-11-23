const DEFAULT_BASE_PATH = "/api";

function normalizePath(pathValue: string | undefined): string {
  if (!pathValue || !pathValue.trim()) {
    return DEFAULT_BASE_PATH;
  }

  let normalized = pathValue.trim();

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      normalized = url.pathname || DEFAULT_BASE_PATH;
    } catch {
      return DEFAULT_BASE_PATH;
    }
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  // remove trailing slashes while preserving root "/"
  normalized = normalized.replace(/\/+$/, "") || "/";

  return normalized || DEFAULT_BASE_PATH;
}

export function getApiBasePath(envValue?: string): string {
  const path = normalizePath(envValue);
  return path === "" ? DEFAULT_BASE_PATH : path;
}

