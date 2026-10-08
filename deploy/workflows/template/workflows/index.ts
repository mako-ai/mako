// The one list the worker registers. Add every workflow here.
import { hatchet } from "./hatchet";
import { customerHealth } from "./customer-health.workflow";
import { dailyDigest } from "./daily-digest.workflow";

export { hatchet };
export const workflows = [customerHealth, dailyDigest];
