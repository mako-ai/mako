/**
 * Viewing and shipping an app: the published view URL, edit mode,
 * publish, preview builds and the dev preview.
 */
import {
  api,
  unwrapBody,
  toErrorMessage as message,
  toLoadError,
} from "../../api";
import { reachableViewUrl } from "../../lib/app-frame";
import { devServerKeyMatches } from "./helpers";
import { viewTokenRequests, VIEW_TOKEN_REUSE_MARGIN_MS } from "./runtime";
import type { AppsSlice } from "./slice";

type Keys =
  | "fetchViewUrl"
  | "setEditing"
  | "publishApp"
  | "buildPreview"
  | "startDevPreview"
  | "setViewMode";

export const createAppsPublishSlice: AppsSlice<Keys> = (set, get) => ({
  fetchViewUrl: async (workspaceId, ref, options = {}) => {
    if (options.reuseFresh) {
      // A prefetch (UrlSync asks by slug the moment the address bar
      // names an app, in parallel with GET /apps) may already be on its
      // way; its answer is filed under the id this caller knows.
      const pending = [...viewTokenRequests.entries()]
        .filter(([key]) => key.startsWith(`${workspaceId}:`))
        .map(([, request]) => request);
      if (pending.length) await Promise.allSettled(pending);
      const state = get();
      const held = state.viewTokenByApp[ref];
      const publishedSha = state.apps.find(a => a.id === ref)?.publishedSha;
      if (
        held &&
        state.viewUrlByApp[ref] &&
        (!publishedSha || held.sha === publishedSha) &&
        held.expiresAt - Date.now() > VIEW_TOKEN_REUSE_MARGIN_MS
      ) {
        return;
      }
    }
    // A retry reads as loading again, not as the old error.
    if (!options.speculative && get().viewUrlErrorByApp[ref]) {
      set(s => {
        s.viewUrlErrorByApp[ref] = undefined;
      });
    }
    const key = `${workspaceId}:${ref}`;
    const request = (async () => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/view-token", {
            params: { path: { workspaceId, id: ref } },
          }),
        ) as {
          url?: string;
          sha?: string;
          expiresAt?: number;
          appId?: string;
        };
        const appId = body.appId ?? ref;
        const url = body.url ? await reachableViewUrl(body.url) : undefined;
        set(s => {
          s.viewUrlByApp[appId] = url;
          s.viewUrlErrorByApp[appId] = undefined;
          s.viewTokenByApp[appId] =
            body.sha && body.expiresAt
              ? { sha: body.sha, expiresAt: body.expiresAt }
              : undefined;
        });
      } catch (e) {
        if (options.speculative) return;
        // Not published, or the token could not be minted. The workspace
        // shows the error for a published app and its "nothing to view
        // yet" state otherwise — never a broken frame.
        set(s => {
          s.viewUrlByApp[ref] = undefined;
          s.viewTokenByApp[ref] = undefined;
          s.viewUrlErrorByApp[ref] = toLoadError(
            e,
            "The published app could not be opened.",
          );
        });
      }
    })();
    viewTokenRequests.set(key, request);
    try {
      await request;
    } finally {
      if (viewTokenRequests.get(key) === request) {
        viewTokenRequests.delete(key);
      }
    }
  },

  setEditing: (workspaceId, appId, editing) => {
    set(s => {
      s.editingByApp[appId] = editing;
    });
    // NOT persisted to localStorage. Whether the workbench opens is derived
    // from box truth (a running dev server), decided on mount — persisting a
    // flag here auto-opened the workbench over an empty box and disagreed
    // with the green dot (apps.md §13.11: the box is the one source of
    // truth for "is this running").
    // Entering edit mode starts a sandbox, and the sandbox is what reads
    // are served from — so re-read once it exists, or the tree stays on the
    // committed view until something else changes.
    if (editing) {
      void get().fetchFiles(workspaceId, appId);
      void get().fetchStatus(workspaceId, appId);
    }
  },

  publishApp: async (workspaceId, appId) => {
    set(s => {
      s.previewByApp[appId] = {
        ...(s.previewByApp[appId] ?? { url: null }),
        building: true,
        publishing: true,
        buildOutput: "",
        error: null,
      };
    });
    // Tail the sandbox build log while the publish runs, so the terminal
    // shows npm install + vite build live instead of a silent spinner.
    let stopTail = false;
    const tail = (async () => {
      let offset = 0;
      while (!stopTail) {
        try {
          const res = await api.GET(
            "/api/workspaces/{workspaceId}/apps/{id}/build/log",
            {
              params: {
                path: { workspaceId, id: appId },
                query: { offset },
              },
            },
          );
          if (res.response.ok) {
            const body = (res.data ?? {}) as {
              size?: number;
              chunk?: string;
            };
            if (body.chunk) {
              set(s => {
                const p = s.previewByApp[appId];
                if (p) p.buildOutput = (p.buildOutput ?? "") + body.chunk;
              });
            }
            offset = body.size ?? offset;
          }
        } catch {
          // A missed poll is fine; the next one resumes from `offset`.
        }
        await new Promise(r => setTimeout(r, 500));
      }
    })();
    try {
      const res = await api.POST(
        "/api/workspaces/{workspaceId}/apps/{id}/publish",
        {
          params: { path: { workspaceId, id: appId } },
          body: {},
        },
      );
      const raw = (res.data ?? res.error) as
        | {
            success?: boolean;
            sha?: string;
            error?: string;
            output?: string;
          }
        | undefined;
      if (res.response.ok && raw?.sha) {
        set(s => {
          const app = s.apps.find(a => a.id === appId);
          if (app) {
            app.publishedSha = raw.sha;
            app.publishedAt = new Date().toISOString();
          }
          const p = s.previewByApp[appId];
          s.previewByApp[appId] = {
            ...(p ?? { url: null }),
            building: false,
            publishing: false,
            error: null,
          };
        });
      } else {
        // Surface the build output (tsc/vite errors) — without it a failed
        // publish is just "Build failed" with nothing to act on. The full
        // build log is already in `buildOutput` (tailed live above).
        const detail = [raw?.error, raw?.output].filter(Boolean).join("\n\n");
        set(s => {
          const p = s.previewByApp[appId];
          s.previewByApp[appId] = {
            ...(p ?? { url: null }),
            building: false,
            publishing: false,
            error: detail || "Publish failed",
          };
        });
      }
    } catch (e) {
      set(s => {
        const p = s.previewByApp[appId];
        s.previewByApp[appId] = {
          ...(p ?? { url: null }),
          building: false,
          publishing: false,
          error: message(e, "Publish failed"),
        };
      });
    } finally {
      stopTail = true;
      void tail;
    }
  },

  buildPreview: async (workspaceId, appId) => {
    set(s => {
      s.previewByApp[appId] = {
        ...(s.previewByApp[appId] ?? { url: null }),
        building: true,
        error: null,
      };
    });
    try {
      const res = await api.POST(
        "/api/workspaces/{workspaceId}/apps/{id}/preview",
        {
          params: { path: { workspaceId, id: appId } },
          body: undefined,
        },
      );
      const raw = (res.data ?? res.error) as
        | {
            success?: boolean;
            url?: string;
            buildOutput?: string;
            error?: string;
            stdout?: string;
            stderr?: string;
          }
        | undefined;
      if (res.response.ok && raw?.url) {
        set(s => {
          s.previewByApp[appId] = {
            url: raw.url ?? null,
            building: false,
            error: null,
            buildOutput: raw.buildOutput,
            builtAt: Date.now(),
            mode: "static",
          };
          s.viewMode[appId] = "preview";
        });
      } else {
        const detail = [raw?.error, raw?.stdout, raw?.stderr]
          .filter(Boolean)
          .join("\n");
        set(s => {
          s.previewByApp[appId] = {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: false,
            error: detail || "Build failed",
          };
        });
      }
      void get().fetchStatus(workspaceId, appId);
    } catch (e) {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: false,
          error: message(e, "Build failed"),
        };
      });
    }
  },

  startDevPreview: async (workspaceId, appId, opts) => {
    // Optimistic reattach: if this app had a dev server last time, its URL
    // is almost certainly still valid (the sandbox sleeps rather than
    // dies), so show the iframe IMMEDIATELY and let the POST revalidate
    // behind it. Cold starts still show the boot state — there is no
    // remembered URL to be optimistic with. A stale URL costs a broken
    // iframe for the seconds until the POST corrects it; the alternative
    // cost 10+ seconds of "Starting..." on every reload, for a server
    // that was already running.
    let optimistic: string | null = null;
    try {
      optimistic = localStorage.getItem(`apps-devurl:${appId}`);
    } catch {
      // Storage unavailable — no optimism, same as before.
    }
    // The remembered URL embeds a sandbox id, and box truth can prove it
    // dead: an offline box, or a live box with a DIFFERENT id, means the
    // URL is a corpse — optimism would iframe E2B's error page for the
    // whole post-recycle cold boot (clone + install + vite, not seconds).
    const { boxStatus, boxSandboxId } = get();
    if (
      optimistic &&
      (boxStatus === "offline" ||
        (boxSandboxId && !optimistic.includes(boxSandboxId)))
    ) {
      optimistic = null;
      try {
        localStorage.removeItem(`apps-devurl:${appId}`);
      } catch {
        // Best effort.
      }
    }
    set(s => {
      s.previewByApp[appId] = optimistic
        ? {
            url: optimistic,
            building: false,
            error: null,
            builtAt: Date.now(),
            mode: "dev",
          }
        : {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: true,
            error: null,
          };
      if (optimistic) s.viewMode[appId] = "preview";
    });
    try {
      // One retry, for the takeover shape: when another app's dev server
      // owns the port, the first request kills it, reinstalls and relaunches
      // — which can outlive a transport deadline even though the server
      // finishes the job. The second request finds the right server already
      // listening and returns in milliseconds. Retrying anything else once
      // is harmless; the second failure is the one reported.
      const restartBody = opts?.restart ? { restart: true } : undefined;
      let res = await api.POST(
        "/api/workspaces/{workspaceId}/apps/{id}/dev-preview",
        {
          params: { path: { workspaceId, id: appId } },
          body: restartBody,
        },
      );
      if (!res.response.ok) {
        // The retry must NOT restart again — the first call already did;
        // a second reap would kill the server it just booted.
        res = await api.POST(
          "/api/workspaces/{workspaceId}/apps/{id}/dev-preview",
          {
            params: { path: { workspaceId, id: appId } },
            body: undefined,
          },
        );
      }
      const raw = (res.data ?? res.error) as
        | {
            success?: boolean;
            url?: string;
            error?: string;
            evicted?: string[];
          }
        | undefined;
      if (res.response.ok && raw?.url) {
        // The box enforces a running cap; if starting this one closed
        // others, reflect that immediately instead of waiting for the next
        // running-servers poll — clear their dots and preview state.
        const evicted = raw.evicted ?? [];
        if (evicted.length) {
          const apps = get().apps;
          set(s => {
            s.runningDevApps = s.runningDevApps.filter(
              sl => !evicted.includes(sl),
            );
          });
          for (const sl of evicted) {
            const a = apps.find(x => devServerKeyMatches(sl, x));
            if (a) get().markDevDown(a.id);
          }
        }
        try {
          localStorage.setItem(`apps-devurl:${appId}`, raw.url);
        } catch {
          // Best effort.
        }
        set(s => {
          s.previewByApp[appId] = {
            url: raw.url ?? null,
            building: false,
            error: null,
            builtAt: Date.now(),
            mode: "dev",
          };
          s.viewMode[appId] = "preview";
        });
      } else {
        set(s => {
          s.previewByApp[appId] = {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: false,
            error: raw?.error ?? "Failed to start dev preview",
          };
        });
      }
    } catch (e) {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: false,
          error: message(e, "Failed to start dev preview"),
        };
      });
    }
  },

  setViewMode: (appId, mode) => {
    set(s => {
      s.viewMode[appId] = mode;
    });
  },
});
