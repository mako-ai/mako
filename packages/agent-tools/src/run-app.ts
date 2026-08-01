/**
 * Shared contract for the canonical cross-surface `run_app` capability.
 *
 * One tool name, one result envelope, three delivery adapters:
 *   - external MCP  → server-side headless render (api/src/mcp/preview-tools.ts)
 *   - Desktop ACP   → mako-desktop loopback bridge against the live iframe
 *   - in-chat       → client executor against the live iframe
 *
 * Every adapter returns a `RunAppResult`; only the capture mechanics differ.
 * Inputs share `runAppBaseSchema` (adapters may extend it — e.g. the headless
 * renderer adds viewport width/height, meaningless for a live iframe).
 */
import { z } from "zod";

/** Wait budget for the preview to report ready/error (all adapters). */
export const RUN_APP_DEFAULT_TIMEOUT_MS = 20_000;
export const RUN_APP_MIN_TIMEOUT_MS = 5_000;
export const RUN_APP_MAX_TIMEOUT_MS = 45_000;

export function clampRunAppTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(
    Math.max(timeoutMs ?? RUN_APP_DEFAULT_TIMEOUT_MS, RUN_APP_MIN_TIMEOUT_MS),
    RUN_APP_MAX_TIMEOUT_MS,
  );
}

/** Render viewport bounds shared by every adapter (headless + live iframe). */
export const RUN_APP_MIN_VIEWPORT_PX = 320;
export const RUN_APP_MAX_VIEWPORT_PX = 1920;

/**
 * Named viewports for verifying responsive layouts. One list feeds the
 * preview toolbar toggle, the app_set_preview_viewport tool, and skill
 * guidance — media queries respond to the (iframe or headless) viewport, so
 * rendering at these sizes IS the mobile/tablet layout check.
 */
export const APP_PREVIEW_VIEWPORT_PRESETS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
} as const;

export type AppPreviewViewportPreset = keyof typeof APP_PREVIEW_VIEWPORT_PRESETS;

const viewportPxField = (axis: "width" | "height") =>
  z
    .number()
    .int()
    .min(RUN_APP_MIN_VIEWPORT_PX)
    .max(RUN_APP_MAX_VIEWPORT_PX)
    .optional()
    .describe(
      `Viewport ${axis} in px. Pass e.g. 390x844 to verify the MOBILE ` +
        "layout (media queries respond to this size). Omit for the default " +
        "desktop viewport.",
    );

export const runAppBaseSchema = z.object({
  appId: z.string().describe("App ID (from list_open_apps)"),
  rebuild: z
    .boolean()
    .optional()
    .describe(
      "Default true. false = report the current preview state without " +
        "forcing a rebuild (no preview flash).",
    ),
  includeScreenshot: z
    .boolean()
    .optional()
    .describe(
      "Default true. Pass false to get status/errors only — much cheaper " +
        "when you just need to know whether the render succeeded.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(RUN_APP_MIN_TIMEOUT_MS)
    .max(RUN_APP_MAX_TIMEOUT_MS)
    .optional()
    .describe("How long to wait for the app to finish rendering (ms)"),
  width: viewportPxField("width"),
  height: viewportPxField("height"),
});

export type RunAppBaseInput = z.infer<typeof runAppBaseSchema>;

export interface RunAppScreenshot {
  mimeType: string;
  /** Raw base64, no data: prefix. */
  base64: string;
}

/** Which adapter produced the result (and therefore what the pixels show). */
export type RunAppSource = "headless" | "desktop" | "iframe";

export interface RunAppResult {
  success: boolean;
  /** ready | error | timeout — what the preview reported within the budget. */
  status: "ready" | "error" | "timeout";
  errors: Array<string | { message: string; source?: string }>;
  consoleLogs: string[];
  source: RunAppSource;
  /** Present when captured AND delivered inline (MCP / desktop bridge). */
  screenshot?: RunAppScreenshot;
  /** Why no screenshot came back (renderer unconfigured, capture failed…). */
  screenshotUnavailableReason?: string;
  /** Transport-level failure detail (render pool crash, unreachable base…). */
  error?: string;
}

/**
 * The JSON-safe half of a result: everything except the screenshot bytes.
 * What adapters put in text/tool-result parts — base64 never travels as text.
 */
export function summarizeRunAppResult(
  result: RunAppResult,
): Omit<RunAppResult, "screenshot"> {
  const { screenshot: _screenshot, ...summary } = result;
  return summary;
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type RunAppMcpContent = McpTextContent | McpImageContent;

/**
 * MCP tool-result content for a RunAppResult: JSON summary text plus an image
 * block when a screenshot is present. Both MCP-facing adapters (headless
 * bridge, mako-desktop loopback) format through here so clients see one shape.
 */
export function runAppResultToMcpContent(
  result: RunAppResult,
): RunAppMcpContent[] {
  const content: RunAppMcpContent[] = [
    { type: "text", text: JSON.stringify(summarizeRunAppResult(result)) },
  ];
  if (result.screenshot) {
    content.push({
      type: "image",
      data: result.screenshot.base64,
      mimeType: result.screenshot.mimeType,
    });
  }
  return content;
}

/** Type guard for envelopes crossing loosely-typed boundaries (bridge jobs). */
export function isRunAppResult(value: unknown): value is RunAppResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunAppResult>;
  return (
    typeof candidate.success === "boolean" &&
    (candidate.status === "ready" ||
      candidate.status === "error" ||
      candidate.status === "timeout") &&
    Array.isArray(candidate.errors) &&
    (candidate.source === "headless" ||
      candidate.source === "desktop" ||
      candidate.source === "iframe")
  );
}
