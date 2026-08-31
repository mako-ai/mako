import { Inngest } from "inngest";
import { LogTapeInngestLogger } from "./logging";

// Note: LogTape is configured once in api/src/logging/index.ts
// The LogTapeInngestLogger uses the global LogTape configuration
const inngestEnv = process.env.INNGEST_ENV?.trim();

export const inngest = new Inngest({
  id: "mako-sync",
  ...(inngestEnv ? { env: inngestEnv } : {}),
  name: "Mako Sync",
  logger: new LogTapeInngestLogger(["inngest"]),
  // v4 defaults to cloud mode (v3 defaulted to dev). Local dev talks to the
  // Inngest Dev Server; deployed environments run cloud mode with
  // INNGEST_SIGNING_KEY from the environment.
  isDev: process.env.NODE_ENV !== "production",
});
