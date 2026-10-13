import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1";

// Reads HATCHET_CLIENT_TOKEN from the environment. Native Hatchet client.
export const hatchet = HatchetClient.init();
