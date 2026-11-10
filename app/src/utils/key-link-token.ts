/**
 * The token of a key link (`/connection-key/<workspaceId>#<token>`).
 *
 * The token is a one-time credential, so it never sits in a path or query
 * string: a browser does not send the fragment to any server, and page-view
 * analytics record the path only. On arrival the page takes it off the
 * address bar and keeps it in sessionStorage, so it also survives a sign-in
 * round trip (the login `returnTo` carries the path alone) and is never in
 * the URL an analytics tag reads.
 */

const STORAGE_PREFIX = "mako:key-link:";

export interface KeyLinkEnv {
  hash: string;
  pathname: string;
  search: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Replace the address bar's URL without navigating. */
  replaceUrl: (url: string) => void;
}

function browserEnv(): KeyLinkEnv {
  let storage: KeyLinkEnv["storage"];
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search,
    storage,
    replaceUrl: url =>
      window.history.replaceState(window.history.state, "", url),
  };
}

/**
 * The token for this workspace's key link: from the fragment (which is then
 * removed from the address bar) or from an earlier visit in this tab.
 */
export function takeKeyLinkToken(
  workspaceId: string,
  env: KeyLinkEnv = browserEnv(),
): string {
  const key = STORAGE_PREFIX + workspaceId;
  const fromHash = decodeURIComponent(env.hash.replace(/^#/, ""));
  if (fromHash) {
    try {
      env.storage?.setItem(key, fromHash);
    } catch {
      // Storage unavailable: the token lives only in this page's memory.
    }
    env.replaceUrl(`${env.pathname}${env.search}`);
    return fromHash;
  }
  try {
    return env.storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Forget the token once the link has been used. */
export function forgetKeyLinkToken(
  workspaceId: string,
  env: Pick<KeyLinkEnv, "storage"> = browserEnv(),
): void {
  try {
    env.storage?.removeItem(STORAGE_PREFIX + workspaceId);
  } catch {
    // Nothing to forget.
  }
}
