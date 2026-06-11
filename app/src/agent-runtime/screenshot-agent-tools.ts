import { useDashboardStore } from "../store/dashboardStore";
import { PREVIEW_MESSAGE } from "../app-runtime/preview";

type ScreenshotTarget =
  | "active_dashboard"
  | "active_tab"
  | "app_shell"
  | "dashboard"
  | "viewport"
  | "widget"
  | "selector";

type ScreenshotRendererName = "modern-screenshot";

interface CaptureScreenshotInput {
  target?: ScreenshotTarget;
  dashboardId?: string;
  widgetId?: string;
  selector?: string;
  scale?: number;
  backgroundColor?: string | null;
  passImageToModel?: boolean;
  downloadImage?: boolean;
}

export interface ScreenshotVisionAttachment {
  renderer: ScreenshotRendererName;
  filename: string;
  mediaType: "image/png";
  dataUrl: string;
  outputBytes: number;
  targetLabel: string;
}

interface ResourceTimingSummary {
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  resourceCount: number;
  resources: Array<{
    name: string;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
  }>;
}

interface MemorySnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface FeatureRect {
  kind: "svg" | "canvas";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FeatureRegionResult extends FeatureRect {
  nonTransparentRatio: number;
  colorVariance: number;
  likelyRendered: boolean;
}

interface ImageQualityMetrics {
  width: number;
  height: number;
  nonTransparentRatio: number;
  nonWhiteRatio: number;
  colorVariance: number;
  uniqueSampledColors: number;
  likelyBlank: boolean;
  svgCanvasRegions: {
    expectedCount: number;
    likelyRenderedCount: number;
    details: FeatureRegionResult[];
  };
  score: number;
}

const MAX_MODEL_IMAGE_BYTES = 2_000_000;
const pendingVisionAttachments: ScreenshotVisionAttachment[] = [];

function now(): number {
  return performance.now();
}

function getMemorySnapshot(): MemorySnapshot | null {
  const maybePerformance = performance as Performance & {
    memory?: MemorySnapshot;
  };
  return maybePerformance.memory ?? null;
}

function memoryDeltaBytes(
  before: MemorySnapshot | null,
  after: MemorySnapshot | null,
): number | undefined {
  if (!before?.usedJSHeapSize || !after?.usedJSHeapSize) return undefined;
  return after.usedJSHeapSize - before.usedJSHeapSize;
}

function escapeAttributeValue(value: string): string {
  const css = globalThis.CSS as
    | { escape?: (value: string) => string }
    | undefined;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function getDashboardCanvasSelector(dashboardId: string): string {
  return `[data-mako-dashboard-canvas="true"][data-mako-dashboard-id="${escapeAttributeValue(
    dashboardId,
  )}"]`;
}

function getWidgetSelector(dashboardId: string, widgetId: string): string {
  return `[data-mako-dashboard-widget-id="${escapeAttributeValue(
    widgetId,
  )}"][data-mako-dashboard-id="${escapeAttributeValue(dashboardId)}"]`;
}

function resolveTarget(input: CaptureScreenshotInput): {
  element: HTMLElement | null;
  requestedTarget: ScreenshotTarget;
  resolvedTarget: string;
  dashboardId?: string;
  widgetId?: string;
  selector?: string;
  error?: string;
} {
  const requestedTarget = input.target ?? "active_dashboard";
  const store = useDashboardStore.getState();
  const dashboardId = input.dashboardId ?? store.activeDashboardId ?? undefined;

  if (requestedTarget === "viewport") {
    return {
      element: document.body,
      requestedTarget,
      resolvedTarget: "viewport",
    };
  }

  if (requestedTarget === "app_shell") {
    const selector = '[data-mako-app-shell="true"]';
    return {
      element: document.querySelector(selector) as HTMLElement | null,
      requestedTarget,
      resolvedTarget: "app_shell",
      selector,
    };
  }

  if (requestedTarget === "active_tab") {
    const selector = '[data-mako-active-tab-content="true"]';
    return {
      element: document.querySelector(selector) as HTMLElement | null,
      requestedTarget,
      resolvedTarget: "active_tab",
      selector,
    };
  }

  if (requestedTarget === "selector") {
    if (!input.selector) {
      return {
        element: null,
        requestedTarget,
        resolvedTarget: "selector",
        error: "selector is required when target is selector.",
      };
    }
    return {
      element: document.querySelector(input.selector) as HTMLElement | null,
      requestedTarget,
      resolvedTarget: "selector",
      selector: input.selector,
    };
  }

  if (requestedTarget === "widget") {
    if (!dashboardId || !input.widgetId) {
      return {
        element: null,
        requestedTarget,
        resolvedTarget: "widget",
        dashboardId,
        widgetId: input.widgetId,
        error: "dashboardId and widgetId are required when target is widget.",
      };
    }
    const selector = getWidgetSelector(dashboardId, input.widgetId);
    return {
      element: document.querySelector(selector) as HTMLElement | null,
      requestedTarget,
      resolvedTarget: "widget",
      dashboardId,
      widgetId: input.widgetId,
      selector,
    };
  }

  if (!dashboardId) {
    return {
      element: null,
      requestedTarget,
      resolvedTarget: requestedTarget,
      error:
        "No active dashboard found. Open a dashboard or pass dashboardId explicitly.",
    };
  }

  const selector = getDashboardCanvasSelector(dashboardId);
  const element =
    (document.querySelector(selector) as HTMLElement | null) ??
    (document.querySelector(".layout") as HTMLElement | null);

  return {
    element,
    requestedTarget,
    resolvedTarget:
      requestedTarget === "dashboard" ? "dashboard" : "active_dashboard",
    dashboardId,
    selector,
  };
}

function getVisibleFeatureRects(target: HTMLElement): FeatureRect[] {
  const targetRect = target.getBoundingClientRect();
  return Array.from(target.querySelectorAll("svg, canvas"))
    .map(node => {
      const element = node as SVGElement | HTMLCanvasElement;
      const rect = element.getBoundingClientRect();
      return {
        kind: element.tagName.toLowerCase() === "canvas" ? "canvas" : "svg",
        x: Math.max(0, rect.left - targetRect.left),
        y: Math.max(0, rect.top - targetRect.top),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      } satisfies FeatureRect;
    })
    .filter(rect => rect.width >= 8 && rect.height >= 8);
}

function summarizeDom(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return {
    tagName: target.tagName.toLowerCase(),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    svgCount: target.querySelectorAll("svg").length,
    canvasCount: target.querySelectorAll("canvas").length,
    imageCount: target.querySelectorAll("img").length,
    elementCount: target.querySelectorAll("*").length,
  };
}

async function waitForStableFrame(): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function getResourceEntriesSince(
  startTime: number,
): PerformanceResourceTiming[] {
  return performance
    .getEntriesByType("resource")
    .filter(
      (entry): entry is PerformanceResourceTiming =>
        entry.entryType === "resource" && entry.startTime >= startTime,
    );
}

function summarizeResources(
  entries: PerformanceResourceTiming[],
): ResourceTimingSummary {
  const matching = entries.filter(entry =>
    entry.name.includes("modern-screenshot"),
  );
  const considered = matching.length > 0 ? matching : entries;
  const resources = considered.map(entry => ({
    name: entry.name,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize,
  }));

  return {
    transferSize: resources.reduce((sum, r) => sum + r.transferSize, 0),
    encodedBodySize: resources.reduce((sum, r) => sum + r.encodedBodySize, 0),
    decodedBodySize: resources.reduce((sum, r) => sum + r.decodedBodySize, 0),
    resourceCount: resources.length,
    resources: resources.slice(0, 8),
  };
}

function dataUrlToBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return dataUrl.length;
  const base64 = dataUrl.slice(commaIndex + 1);
  return Math.floor((base64.length * 3) / 4);
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildScreenshotFilename(params: {
  renderer: ScreenshotRendererName;
  resolvedTarget: string;
  dashboardId?: string;
  widgetId?: string;
}): string {
  const parts = [
    "mako",
    "screenshot",
    params.renderer,
    params.resolvedTarget,
    params.dashboardId ? sanitizeFilenamePart(params.dashboardId) : null,
    params.widgetId ? sanitizeFilenamePart(params.widgetId) : null,
  ].filter(Boolean);
  return `${parts.join("-")}.png`;
}

function triggerDownload(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Failed to decode screenshot image"));
    image.src = dataUrl;
  });
}

function analyzeRegion(
  ctx: CanvasRenderingContext2D,
  region: { x: number; y: number; width: number; height: number },
): {
  nonTransparentRatio: number;
  nonWhiteRatio: number;
  colorVariance: number;
  uniqueSampledColors: number;
} {
  const maxSamples = 48;
  const width = Math.max(
    1,
    Math.min(ctx.canvas.width, Math.round(region.width)),
  );
  const height = Math.max(
    1,
    Math.min(ctx.canvas.height, Math.round(region.height)),
  );
  const startX = Math.max(
    0,
    Math.min(ctx.canvas.width - width, Math.round(region.x)),
  );
  const startY = Math.max(
    0,
    Math.min(ctx.canvas.height - height, Math.round(region.y)),
  );
  const imageData = ctx.getImageData(startX, startY, width, height).data;
  const stepX = Math.max(1, Math.floor(width / maxSamples));
  const stepY = Math.max(1, Math.floor(height / maxSamples));
  let samples = 0;
  let nonTransparent = 0;
  let nonWhite = 0;
  let brightnessSum = 0;
  let brightnessSquaredSum = 0;
  const colors = new Set<string>();

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * 4;
      const r = imageData[offset] ?? 0;
      const g = imageData[offset + 1] ?? 0;
      const b = imageData[offset + 2] ?? 0;
      const a = imageData[offset + 3] ?? 0;
      const brightness = (r + g + b) / 3;
      samples += 1;
      if (a > 8) nonTransparent += 1;
      if (a > 8 && (r < 245 || g < 245 || b < 245)) nonWhite += 1;
      brightnessSum += brightness;
      brightnessSquaredSum += brightness * brightness;
      colors.add(`${r >> 4}:${g >> 4}:${b >> 4}:${a >> 4}`);
    }
  }

  const mean = samples > 0 ? brightnessSum / samples : 0;
  const variance =
    samples > 0 ? Math.max(0, brightnessSquaredSum / samples - mean * mean) : 0;

  return {
    nonTransparentRatio: samples > 0 ? nonTransparent / samples : 0,
    nonWhiteRatio: samples > 0 ? nonWhite / samples : 0,
    colorVariance: variance,
    uniqueSampledColors: colors.size,
  };
}

async function analyzeImageQuality(
  dataUrl: string,
  target: HTMLElement,
  featureRects: FeatureRect[],
): Promise<ImageQualityMetrics> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    throw new Error("Unable to analyze screenshot pixels.");
  }
  ctx.drawImage(image, 0, 0);

  const full = analyzeRegion(ctx, {
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
  });
  const targetRect = target.getBoundingClientRect();
  const scaleX = targetRect.width > 0 ? canvas.width / targetRect.width : 1;
  const scaleY = targetRect.height > 0 ? canvas.height / targetRect.height : 1;

  const featureResults = featureRects.map(rect => {
    const metrics = analyzeRegion(ctx, {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    });
    return {
      ...rect,
      nonTransparentRatio: metrics.nonTransparentRatio,
      colorVariance: metrics.colorVariance,
      likelyRendered:
        metrics.nonTransparentRatio > 0.15 &&
        (metrics.nonWhiteRatio > 0.02 ||
          metrics.colorVariance > 8 ||
          metrics.uniqueSampledColors > 4),
    } satisfies FeatureRegionResult;
  });

  const likelyBlank =
    full.nonTransparentRatio < 0.05 ||
    (full.nonWhiteRatio < 0.01 &&
      full.colorVariance < 2 &&
      full.uniqueSampledColors < 4);
  const likelyRenderedCount = featureResults.filter(
    r => r.likelyRendered,
  ).length;
  const featureCoverage =
    featureResults.length === 0
      ? 1
      : likelyRenderedCount / featureResults.length;
  const score = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        (likelyBlank ? 10 : 70) +
          Math.min(20, full.colorVariance / 4) +
          featureCoverage * 10,
      ),
    ),
  );

  return {
    width: canvas.width,
    height: canvas.height,
    nonTransparentRatio: Number(full.nonTransparentRatio.toFixed(4)),
    nonWhiteRatio: Number(full.nonWhiteRatio.toFixed(4)),
    colorVariance: Number(full.colorVariance.toFixed(2)),
    uniqueSampledColors: full.uniqueSampledColors,
    likelyBlank,
    svgCanvasRegions: {
      expectedCount: featureResults.length,
      likelyRenderedCount,
      details: featureResults.map(detail => ({
        ...detail,
        x: Math.round(detail.x),
        y: Math.round(detail.y),
        width: Math.round(detail.width),
        height: Math.round(detail.height),
        nonTransparentRatio: Number(detail.nonTransparentRatio.toFixed(4)),
        colorVariance: Number(detail.colorVariance.toFixed(2)),
      })),
    },
    score,
  };
}

/**
 * App previews render in opaque-origin iframes (`sandbox="allow-scripts"`),
 * which modern-screenshot cannot rasterize from the parent — they come out
 * blank. Ask each visible app-preview iframe inside the capture target to
 * screenshot itself (the preview bootstrap handles `mako-app:capture`) and
 * composite the returned PNGs over the parent capture at the iframe rects.
 */
const APP_PREVIEW_IFRAME_SELECTOR = "iframe[data-mako-app-preview]";
const APP_PREVIEW_CAPTURE_TIMEOUT_MS = 8000;
let captureSeq = 0;

function findAppPreviewIframes(target: HTMLElement): HTMLIFrameElement[] {
  const iframes = Array.from(
    target.querySelectorAll<HTMLIFrameElement>(APP_PREVIEW_IFRAME_SELECTOR),
  );
  if (
    target instanceof HTMLIFrameElement &&
    target.matches(APP_PREVIEW_IFRAME_SELECTOR)
  ) {
    iframes.unshift(target);
  }
  return iframes.filter(iframe => {
    const rect = iframe.getBoundingClientRect();
    return rect.width >= 8 && rect.height >= 8 && iframe.contentWindow != null;
  });
}

function requestAppPreviewCapture(
  iframe: HTMLIFrameElement,
  options: { scale: number; backgroundColor?: string | null },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) {
      reject(new Error("App preview iframe has no content window"));
      return;
    }
    const requestId = `capture_${Date.now()}_${++captureSeq}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("App preview capture timed out"));
    }, APP_PREVIEW_CAPTURE_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      const data = (event.data ?? {}) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        dataUrl?: string;
        error?: string;
      };
      if (
        event.source !== contentWindow ||
        data.type !== PREVIEW_MESSAGE.captureResult ||
        data.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (data.success && data.dataUrl) resolve(data.dataUrl);
      else reject(new Error(data.error || "App preview capture failed"));
    }

    window.addEventListener("message", onMessage);
    // The sandboxed iframe has an opaque origin, so "*" is required.
    contentWindow.postMessage(
      {
        type: PREVIEW_MESSAGE.capture,
        requestId,
        scale: options.scale,
        backgroundColor: options.backgroundColor,
      },
      "*",
    );
  });
}

async function compositeAppPreviews(
  baseDataUrl: string,
  target: HTMLElement,
  options: { scale: number; backgroundColor?: string | null },
): Promise<{
  dataUrl: string;
  compositedCount: number;
  failures: string[];
}> {
  const iframes = findAppPreviewIframes(target);
  if (iframes.length === 0) {
    return { dataUrl: baseDataUrl, compositedCount: 0, failures: [] };
  }

  const failures: string[] = [];
  const captures = await Promise.all(
    iframes.map(async iframe => {
      try {
        return {
          iframe,
          dataUrl: await requestAppPreviewCapture(iframe, options),
        };
      } catch (error) {
        failures.push(
          `${iframe.dataset.makoAppPreview ?? "unknown"}: ${
            error instanceof Error ? error.message : "capture failed"
          }`,
        );
        return null;
      }
    }),
  );
  const successful = captures.filter(
    (c): c is { iframe: HTMLIFrameElement; dataUrl: string } => c !== null,
  );
  if (successful.length === 0) {
    return { dataUrl: baseDataUrl, compositedCount: 0, failures };
  }

  const baseImage = await loadImage(baseDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = baseImage.naturalWidth || baseImage.width;
  canvas.height = baseImage.naturalHeight || baseImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { dataUrl: baseDataUrl, compositedCount: 0, failures };
  }
  ctx.drawImage(baseImage, 0, 0);

  const targetRect = target.getBoundingClientRect();
  const scaleX = targetRect.width > 0 ? canvas.width / targetRect.width : 1;
  const scaleY = targetRect.height > 0 ? canvas.height / targetRect.height : 1;

  for (const { iframe, dataUrl } of successful) {
    try {
      const image = await loadImage(dataUrl);
      const rect = iframe.getBoundingClientRect();
      ctx.drawImage(
        image,
        (rect.left - targetRect.left) * scaleX,
        (rect.top - targetRect.top) * scaleY,
        rect.width * scaleX,
        rect.height * scaleY,
      );
    } catch (error) {
      failures.push(
        `${iframe.dataset.makoAppPreview ?? "unknown"}: ${
          error instanceof Error ? error.message : "composite failed"
        }`,
      );
    }
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    compositedCount: successful.length,
    failures,
  };
}

async function captureWithModernScreenshot(
  target: HTMLElement,
  options: { scale: number; backgroundColor?: string | null },
): Promise<{ dataUrl: string; importMs: number; renderMs: number }> {
  const importStarted = now();
  const { domToPng } = await import("modern-screenshot");
  const importMs = now() - importStarted;
  const renderStarted = now();
  const dataUrl = await domToPng(target, {
    backgroundColor: options.backgroundColor ?? null,
    scale: options.scale,
  });
  return {
    dataUrl,
    importMs,
    renderMs: now() - renderStarted,
  };
}

function enqueueVisionAttachment(attachment: ScreenshotVisionAttachment): void {
  pendingVisionAttachments.push(attachment);
}

export function consumePendingScreenshotVisionAttachments(): ScreenshotVisionAttachment[] {
  return pendingVisionAttachments.splice(0, pendingVisionAttachments.length);
}

function createVisionAttachment(params: {
  renderer: ScreenshotRendererName;
  dataUrl: string;
  filename: string;
  outputBytes: number;
  targetLabel: string;
}): ScreenshotVisionAttachment {
  return {
    renderer: params.renderer,
    filename: params.filename,
    mediaType: "image/png",
    dataUrl: params.dataUrl,
    outputBytes: params.outputBytes,
    targetLabel: params.targetLabel,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Screenshot capture cancelled", "AbortError");
  }
}

export async function captureScreenshot(
  input: CaptureScreenshotInput,
  options?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const signal = options?.signal;
  throwIfAborted(signal);
  await waitForStableFrame();
  throwIfAborted(signal);

  const target = resolveTarget(input);
  if (!target.element) {
    return {
      success: false,
      error: target.error ?? "Screenshot target not found.",
      target: {
        requested: target.requestedTarget,
        resolved: target.resolvedTarget,
        dashboardId: target.dashboardId,
        widgetId: target.widgetId,
        selector: target.selector,
      },
    };
  }

  const scale =
    typeof input.scale === "number" && Number.isFinite(input.scale)
      ? Math.min(3, Math.max(0.5, input.scale))
      : 1;
  const domSummary = summarizeDom(target.element);
  const featureRects = getVisibleFeatureRects(target.element);
  const totalStarted = now();
  const resourcesStarted = now();
  const memoryBefore = getMemorySnapshot();

  try {
    const capture = await captureWithModernScreenshot(target.element, {
      scale,
      backgroundColor: input.backgroundColor,
    });
    throwIfAborted(signal);

    // Sandboxed app previews are blank in the parent capture; ask them to
    // self-capture and composite the PNGs at the iframe rects.
    const composite = await compositeAppPreviews(
      capture.dataUrl,
      target.element,
      { scale, backgroundColor: input.backgroundColor },
    );
    throwIfAborted(signal);
    capture.dataUrl = composite.dataUrl;

    const outputBytes = dataUrlToBytes(capture.dataUrl);
    const quality = await analyzeImageQuality(
      capture.dataUrl,
      target.element,
      featureRects,
    );
    const filename = buildScreenshotFilename({
      renderer: "modern-screenshot",
      resolvedTarget: target.resolvedTarget,
      dashboardId: target.dashboardId,
      widgetId: target.widgetId,
    });
    const attachment = createVisionAttachment({
      renderer: "modern-screenshot",
      dataUrl: capture.dataUrl,
      filename,
      outputBytes,
      targetLabel: target.resolvedTarget,
    });
    const imagesPassedToModel: Array<
      Omit<ScreenshotVisionAttachment, "dataUrl">
    > = [];
    const imagesDownloaded: Array<{
      renderer: ScreenshotRendererName;
      filename: string;
    }> = [];

    if (
      input.passImageToModel !== false &&
      outputBytes <= MAX_MODEL_IMAGE_BYTES
    ) {
      enqueueVisionAttachment(attachment);
      imagesPassedToModel.push({
        renderer: attachment.renderer,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        outputBytes: attachment.outputBytes,
        targetLabel: attachment.targetLabel,
      });
    }

    if (input.downloadImage === true) {
      triggerDownload(capture.dataUrl, filename);
      imagesDownloaded.push({ renderer: "modern-screenshot", filename });
    }

    const resourceEntries = getResourceEntriesSince(resourcesStarted);
    const memoryAfter = getMemorySnapshot();

    return {
      success: true,
      renderer: "modern-screenshot",
      target: {
        requested: target.requestedTarget,
        resolved: target.resolvedTarget,
        dashboardId: target.dashboardId,
        widgetId: target.widgetId,
        selector: target.selector,
        ...domSummary,
      },
      scale,
      importMs: Number(capture.importMs.toFixed(1)),
      renderMs: Number(capture.renderMs.toFixed(1)),
      totalMs: Number((now() - totalStarted).toFixed(1)),
      outputBytes,
      dataUrlLength: capture.dataUrl.length,
      memoryDeltaBytes: memoryDeltaBytes(memoryBefore, memoryAfter),
      resourceTiming: summarizeResources(resourceEntries),
      quality,
      appPreviews: {
        composited: composite.compositedCount,
        failures: composite.failures,
      },
      imagesPassedToModel,
      imagesDownloaded,
      measurementNotes: [
        "The screenshot was captured with modern-screenshot.",
        ...(composite.compositedCount > 0
          ? [
              "Sandboxed app preview iframe(s) were self-captured and composited into the screenshot.",
            ]
          : []),
        ...(composite.failures.length > 0
          ? [
              `Some app preview iframe(s) could not be captured and may appear blank: ${composite.failures.join("; ")}`,
            ]
          : []),
        "When passImageToModel is enabled, the screenshot is sent as a real image input in the next model request, not as a base64 string inside the tool result.",
        "Quality is a heuristic based on decoded screenshot pixels, blankness, color variance, and whether visible SVG/canvas regions in the target appear non-blank in the output.",
      ],
    };
  } catch (error) {
    const resourceEntries = getResourceEntriesSince(resourcesStarted);
    const memoryAfter = getMemorySnapshot();
    return {
      success: false,
      renderer: "modern-screenshot",
      target: {
        requested: target.requestedTarget,
        resolved: target.resolvedTarget,
        dashboardId: target.dashboardId,
        widgetId: target.widgetId,
        selector: target.selector,
        ...domSummary,
      },
      error: error instanceof Error ? error.message : "Screenshot failed",
      totalMs: Number((now() - totalStarted).toFixed(1)),
      memoryDeltaBytes: memoryDeltaBytes(memoryBefore, memoryAfter),
      resourceTiming: summarizeResources(resourceEntries),
    };
  }
}
