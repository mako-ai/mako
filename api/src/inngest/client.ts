import { Inngest } from "inngest";
import { configureLogging, LogTapeInngestLogger } from "./logging";

// Configure LogTape on module initialization
void configureLogging();

export const inngest = new Inngest({
  id: "mako-sync",
  name: "Mako Sync",
  logger: new LogTapeInngestLogger(["inngest"]),
});
