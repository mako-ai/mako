import { loggers } from "../../logging";
import type { CdcEventStore } from "../contracts/events";
import { MongoCdcEventStore } from "./mongo-event-store";

const log = loggers.sync("cdc.event-store");

type CdcEventStoreName = "mongo";

export interface CdcEventStoreRuntimeConfig {
  primary: CdcEventStoreName;
}

let cachedStore: CdcEventStore | null = null;
let cachedConfig: CdcEventStoreRuntimeConfig | null = null;

function resolveConfig(): CdcEventStoreRuntimeConfig {
  const raw = process.env.CDC_EVENT_STORE_PRIMARY?.trim().toLowerCase();
  if (raw && raw !== "mongo") {
    log.warn("Unsupported CDC event store primary; defaulting to mongo", {
      value: raw,
    });
  }
  return { primary: "mongo" };
}

export function getCdcEventStore(): CdcEventStore {
  if (!cachedStore || !cachedConfig) {
    cachedConfig = resolveConfig();
    cachedStore = new MongoCdcEventStore();
    log.info("CDC event store initialized", {
      primary: cachedConfig.primary,
    });
  }
  return cachedStore;
}

export function getCdcEventStoreConfig(): CdcEventStoreRuntimeConfig {
  if (!cachedConfig) {
    cachedConfig = resolveConfig();
  }
  return cachedConfig;
}

export function resetCdcEventStoreForTests(): void {
  cachedStore = null;
  cachedConfig = null;
}
