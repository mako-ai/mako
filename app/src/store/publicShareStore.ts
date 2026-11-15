/**
 * The anonymous public share viewer (`/share/:token`). Request-only actions.
 *
 * The one store that calls `fetch` directly, on purpose: the page renders
 * outside the session/workspace shell, for visitors who may have no Mako
 * account, and here a `401` means "this share needs its password" — so the
 * typed client's workspace header and `401` → `/login` redirect must not
 * apply.
 */
import { create } from "zustand";

export interface ShareMeta {
  type: "app";
  title: string;
  passwordRequired: boolean;
  unlocked: boolean;
}

export interface PublicAppContent {
  kind: "app";
  title: string;
  published: boolean;
  entry: string;
  /** The app on its own origin, when the server serves it there. */
  appUrl?: string;
}

export type ShareContent = PublicAppContent;

interface PublicShareStore {
  /** Throws when the link does not resolve. */
  getMeta: (token: string) => Promise<ShareMeta>;
  /** Null while the password gate is closed (401). */
  getContent: (token: string) => Promise<ShareContent | null>;
  /** Throws (with the server's message) on a wrong password. */
  unlock: (token: string, password: string) => Promise<void>;
}

type Envelope<T> = { success?: boolean; error?: string; data?: T } | null;

/** The share routes answer `{ success, data }` / `{ success: false, error }`. */
async function envelope<T>(res: Response, fallback: string): Promise<T> {
  const json = (await res.json().catch(() => null)) as Envelope<T>;
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || fallback);
  }
  return json.data as T;
}

/* eslint-disable no-restricted-syntax -- anonymous public endpoints: see the module comment */
export const usePublicShareStore = create<PublicShareStore>()(() => ({
  getMeta: async token =>
    envelope<ShareMeta>(
      await fetch(`/api/share/${token}`, { credentials: "include" }),
      "Share link not found",
    ),

  getContent: async token => {
    const res = await fetch(`/api/share/${token}/content`, {
      credentials: "include",
    });
    if (res.status === 401) return null; // password gate
    return envelope<ShareContent>(res, "Failed to load content");
  },

  unlock: async (token, password) => {
    await envelope(
      await fetch(`/api/share/${token}/unlock`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      }),
      "Incorrect password",
    );
  },
}));
/* eslint-enable no-restricted-syntax */
