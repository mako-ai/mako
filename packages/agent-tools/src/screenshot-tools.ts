/**
 * Client-Side Screenshot Tool
 *
 * Client-side visual-inspection tool executed in the browser via the AI SDK's
 * onToolCall callback (no execute function). The client captures the requested
 * target with modern-screenshot and returns a PNG that can be passed to the
 * next model step as a real image input and/or downloaded.
 */

import { tool } from "ai";
import { z } from "zod";

const screenshotTargetSchema = z
  .enum([
    "active_dashboard",
    "active_tab",
    "app_shell",
    "dashboard",
    "viewport",
    "widget",
    "selector",
  ])
  .default("active_dashboard")
  .describe(
    "What to capture. Use active_dashboard for dashboard visual QA, active_tab for the current main tab, app_shell for the full Mako app UI, widget for a specific dashboard widget, viewport for the current visible page, or selector for a CSS selector.",
  );

export const captureScreenshotSchema = z.object({
  target: screenshotTargetSchema,
  dashboardId: z
    .string()
    .optional()
    .describe("Dashboard ID. Required when target is dashboard or widget."),
  widgetId: z
    .string()
    .optional()
    .describe("Widget ID. Required when target is widget."),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector to capture when target is selector. Avoid broad selectors unless the user asked for the full page.",
    ),
  scale: z
    .number()
    .min(0.5)
    .max(3)
    .default(1)
    .describe(
      "Screenshot scale. Higher values are sharper but slower and heavier.",
    ),
  backgroundColor: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional screenshot background color. Use null to preserve transparency where supported.",
    ),
  passImageToModel: z
    .boolean()
    .default(true)
    .describe(
      "Pass the screenshot to the next LLM step as a real image input so the model can visually inspect it.",
    ),
  downloadImage: z
    .boolean()
    .default(false)
    .describe(
      "Download the screenshot PNG in the user's browser. Use when the user asks to see/save the screenshot.",
    ),
});

/**
 * Client-side screenshot tool (no execute function = client-side execution).
 */
export const clientScreenshotTools = {
  capture_screenshot: tool({
    description:
      "Capture a screenshot with modern-screenshot for visual debugging. " +
      "Use this when the user asks what is visible, why something looks wrong, or when visual context would help debug the app. " +
      "Supports active_dashboard, active_tab, app_shell, viewport, widget, and selector targets. " +
      "By default, the PNG is passed to the next LLM step as a real image input; it can also be downloaded in the user's browser.",
    inputSchema: captureScreenshotSchema,
    // No execute function - this is a client-side tool
  }),
};

export type CaptureScreenshotInput = z.infer<typeof captureScreenshotSchema>;
