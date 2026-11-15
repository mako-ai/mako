/**
 * Looking at the running app: app_browse, app_open_app.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { buildBrowseModelOutput } from "../browse-model-output";
import { catchUpLiveBox, appRootFor } from "../../../apps/worktree.service";
import { ensureDevServer } from "../../../apps/dev-server.service";
import { getArtifactStore } from "../../../services/artifact-store.service";
import { browseApp, eyesShotKey } from "../../../apps/eyes.service";
import { publishRealtimeEvent } from "../../../services/realtime.service";
import { type AppsToolContext, logger } from "./context";

export function appPreviewTools(ctx: AppsToolContext): ToolSet {
  const {
    workspaceId,
    supportsVision,
    actorId,
    ensureActorWorktree,
    loadProject,
    errorMessage,
  } = ctx;
  return {
    app_browse: tool({
      description:
        "Look at the running app with a real headless browser INSIDE its " +
        "sandbox: navigate, click, type, evaluate JS, then capture a " +
        "screenshot (you SEE it) plus console errors and failed requests. " +
        "Use it after edits to verify what actually renders, and to debug " +
        "blank screens. Needs a running dev session (app_open_app). First " +
        "use in a fresh sandbox installs the browser (~30-60s). When the " +
        "model cannot read images the capture is skipped automatically — " +
        "pageText, console and failed requests still tell you what " +
        "rendered.",
      inputSchema: z.object({
        appId: z.string(),
        steps: z
          .array(
            z.object({
              action: z.enum(["navigate", "click", "type", "wait", "eval"]),
              selector: z
                .string()
                .optional()
                .describe("CSS selector (click/type)."),
              path: z.string().optional().describe("Route path (navigate)."),
              value: z.string().optional().describe("Text to type."),
              expression: z
                .string()
                .optional()
                .describe("JS to evaluate in the page (eval)."),
              ms: z.number().int().max(5000).optional().describe("Wait ms."),
            }),
          )
          .max(10)
          .optional()
          .describe("Actions before the capture; omit to just look at /."),
        screenshot: z
          .boolean()
          .optional()
          .describe("Capture a JPEG screenshot (default true)."),
        origin: z
          .enum(["local", "public"])
          .optional()
          .describe(
            "local (default) hits the dev server inside the sandbox — " +
              "debugs the app itself. public goes through the sandbox's " +
              "public URL — the exact path the user's browser takes, so it " +
              "also verifies the proxy/edge (use when the user reports the " +
              "preview broken but the app looks fine locally).",
          ),
      }),
      execute: async ({ appId, steps, screenshot, origin }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          // Capturing for a model that cannot read images is pure waste: the
          // JPEG is rendered in the sandbox, shipped out, and uploaded to the
          // bucket, and then toModelOutput strips it. Nothing renders
          // screenshotUrl in the UI either, so nobody misses it.
          const wantScreenshot =
            supportsVision === false ? false : screenshot !== false;
          const result = await browseApp(handle, {
            steps,
            screenshot: wantScreenshot,
            origin,
          });
          // Screenshots persist as bucket objects, never as stored base64:
          // the URL survives in chat history (the persistence sanitizer
          // drops the base64), and the serving route re-authorizes reads.
          let screenshotUrl: string | undefined;
          if (result.screenshotBase64) {
            try {
              const shotId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
              const key = eyesShotKey(
                loaded.project._id.toString(),
                `${shotId}.jpg`,
              );
              await getArtifactStore().putBuffer(
                Buffer.from(result.screenshotBase64, "base64"),
                key,
                "image/jpeg",
              );
              screenshotUrl = `/api/workspaces/${workspaceId}/apps/${loaded.project._id.toString()}/eyes-shots/${shotId}.jpg`;
            } catch (uploadError) {
              logger.warn("Could not store the browse screenshot", {
                error: errorMessage(uploadError),
              });
            }
          }
          return { success: result.ok, ...result, screenshotUrl };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      // Mapping (and the two ways it has failed) lives in
      // browse-model-output.ts, next to the test that pins it.
      toModelOutput: ({ output }) =>
        buildBrowseModelOutput(output, supportsVision) as never,
    }),

    app_open_app: tool({
      description:
        "Open an Apps app in the user's Mako UI — focuses its tab — and " +
        "(by default) start its live dev session (vite + HMR) so the user " +
        "watches edits apply live in the preview. Use it after creating an " +
        "app or when asked to show one. Returns the dev preview URL. " +
        "Starts (or reuses) the dev server for the app and focuses its tab in " +
        "git-backed apps.",
      inputSchema: z.object({
        appId: z.string(),
        dev: z
          .boolean()
          .optional()
          .describe("Also start the live dev session (default true)."),
        restart: z
          .boolean()
          .optional()
          .describe(
            "Stop a running dev server first and boot a fresh one — use " +
              "when the server is wedged or must pick up new launcher " +
              "behavior.",
          ),
      }),
      execute: async ({ appId, dev, restart }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          // A running sandbox is the preferred read source and can predate a
          // push that created this app or changed its files. Pull it forward
          // before Vite starts; catchUpLiveBox is deliberately a no-op when
          // the box is asleep, so opening remains the user-authorized boot.
          await catchUpLiveBox(loaded.project, actorId);
          const handle = await ensureActorWorktree(loaded.project);
          let url: string | undefined;
          let evicted: string[] | undefined;
          if (dev !== false) {
            // The same launch the workbench button runs — this call IS the
            // user's click, relayed through their agent (§13.9: starts are
            // user-initiated; this is one).
            const preview = await ensureDevServer(handle, {
              restart: restart === true,
            });
            url = preview.url;
            evicted = preview.evicted;
          }
          // The tab opens in the USER'S browser: a user-scoped UI intent on
          // the workspace channel. Headless callers (MCP) have no browser
          // listening and simply use the returned URL.
          publishRealtimeEvent(workspaceId, {
            type: "app.open-app",
            userId: actorId,
            appId: String(loaded.project._id ?? loaded.project.slug ?? appId),
            slug: loaded.project.slug ?? undefined,
            title: loaded.project.title ?? undefined,
          });
          return {
            success: true,
            app: loaded.project._id.toString(),
            path: appRootFor(loaded.project),
            title: loaded.project.title,
            devServerUrl: url,
            evicted,
            hint:
              dev !== false
                ? "The app tab is open in the user's Mako UI with the live " +
                  "dev session running — file edits hot-reload there."
                : "The app tab is open in the user's Mako UI.",
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}
