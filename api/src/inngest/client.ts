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
});
