/**
 * Langfuse tracing bootstrap.
 *
 * Wires the Vercel AI SDK's built-in OpenTelemetry spans into Langfuse via the
 * `LangfuseSpanProcessor`. The AI SDK emits GenAI spans whenever a call passes
 * `experimental_telemetry: { isEnabled: true }`; the processor's default smart
 * filter only exports Langfuse/GenAI/LLM spans, so unrelated HTTP/DB spans never
 * reach Langfuse (and never count toward billable units).
 *
 * IMPORTANT: `initLangfuseTracing()` must be called AFTER environment variables
 * are loaded (see `api/src/index.ts`). Initializing before `dotenv.config()`
 * would make the processor read missing credentials. When the Langfuse keys are
 * absent the bootstrap is a no-op, so local/dev environments without keys run
 * unaffected.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { loggers } from "../logging";

const logger = loggers.app();

let provider: NodeTracerProvider | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

/**
 * Redact obvious secrets before any input/output/metadata leaves the process.
 *
 * The processor passes the stringified JSON of each attribute value; we run a
 * few defensive regexes so connection strings, bearer tokens, provider API
 * keys, or card numbers can never be persisted in a trace even if they slip
 * into a prompt or tool result. This is a safety net — prompts in this app do
 * not intentionally include secrets.
 */
function maskSensitiveData({ data }: { data: unknown }): unknown {
  if (typeof data !== "string") return data;

  return (
    data
      // URI-style connection strings with embedded credentials
      // (mongodb+srv://user:pass@host, postgres://…, redis://…, etc.)
      .replace(
        /\b[a-z][a-z0-9+.-]*:\/\/[^\s"':@/]+:[^\s"'@/]+@[^\s"']+/gi,
        "***REDACTED_CONNECTION_STRING***",
      )
      // Authorization: Bearer <token>
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer ***REDACTED***")
      // Common provider key shapes (OpenAI sk-/pk-, Vercel vck_, SendGrid SG.)
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
      .replace(/\bvck_[A-Za-z0-9]{12,}/g, "***REDACTED_API_KEY***")
      .replace(/\bSG\.[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
      // Credit card numbers (PCI safety net)
      .replace(
        /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        "***REDACTED_CARD***",
      )
  );
}

/**
 * Initialize Langfuse tracing. Idempotent and safe to call when keys are
 * missing. Returns `true` when tracing was enabled.
 */
export function initLangfuseTracing(): boolean {
  if (provider) return true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    logger.warn(
      "Langfuse tracing disabled: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set",
    );
    return false;
  }

  // Prefer an explicit tracing environment so preview and production
  // deployments (both run with NODE_ENV=production on Cloud Run) stay separate
  // in Langfuse's Environments view. Falls back to NODE_ENV locally.
  const environment =
    process.env.LANGFUSE_TRACING_ENVIRONMENT ||
    process.env.NODE_ENV ||
    "development";

  spanProcessor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
    release: process.env.LANGFUSE_RELEASE,
    mask: maskSensitiveData,
    // Long-running Node process: batch spans for throughput. Short-lived
    // (serverless) deployments should use "immediate" instead.
    exportMode: "batched",
  });

  provider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
  });
  provider.register();

  logger.info("Langfuse tracing initialized", {
    baseUrl: baseUrl || "https://cloud.langfuse.com",
    environment,
  });

  return true;
}

/** Whether Langfuse tracing is active. */
export function isLangfuseEnabled(): boolean {
  return spanProcessor !== null;
}

/**
 * Flush any buffered spans. Cheap no-op when tracing is disabled. Useful before
 * the process exits or when you need traces to appear promptly.
 */
export async function flushLangfuse(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (error) {
    logger.warn("Langfuse flush failed", { error });
  }
}

/** Flush and tear down the tracer provider during graceful shutdown. */
export async function shutdownLangfuse(): Promise<void> {
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch (error) {
    logger.warn("Langfuse shutdown failed", { error });
  }
}
