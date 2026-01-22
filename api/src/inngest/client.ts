import { Inngest } from "inngest";
import { LogTapeInngestLogger } from "./logging";

// Note: LogTape is configured once in api/src/logging/index.ts
// The LogTapeInngestLogger uses the global LogTape configuration

export const inngest = new Inngest({
  id: "mako-sync",
  name: "Mako Sync",
  logger: new LogTapeInngestLogger(["inngest"]),
});
