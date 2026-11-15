import { Db } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Index the scheduler scans (savedconsoles scheduledRun.nextAt, flows schedule.enabled), the abandoned-flow cleanup (flow_executions status+lastHeartbeat) and the chat list sort (chats workspaceId+createdBy+updatedAt)";

const log = loggers.migration();

interface IndexSpec {
  collection: string;
  key: Record<string, 1 | -1>;
  options?: { sparse?: boolean };
  why: string;
}

const INDEXES: IndexSpec[] = [
  {
    collection: "savedconsoles",
    key: { "scheduledRun.nextAt": 1 },
    options: { sparse: true },
    why: "every-minute scheduled-query scan has no workspaceId",
  },
  {
    collection: "flows",
    key: { "schedule.enabled": 1 },
    why: "poll scheduler scan has no workspaceId",
  },
  {
    collection: "flow_executions",
    key: { status: 1, lastHeartbeat: 1 },
    why: "cleanup-abandoned-flows scans running executions by heartbeat",
  },
  {
    collection: "chats",
    key: { workspaceId: 1, createdBy: 1, updatedAt: -1 },
    why: "chat list sorts a user's chats by updatedAt",
  },
];

function hasIndexOnKeys(
  indexes: { key: Record<string, unknown> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

/**
 * Idempotent (checked by key pattern) and safe before or after the code
 * that declares them is live. Mongoose builds the same indexes on start when
 * autoIndex is on; this makes them exist where it is off. The older
 * `{ workspaceId, createdBy }` chat index is left in place: it is a prefix
 * of the new one and dropping it is a separate decision.
 */
export async function up(db: Db): Promise<void> {
  for (const spec of INDEXES) {
    const collection = db.collection(spec.collection);
    let indexes: { key: Record<string, unknown> }[] = [];
    try {
      indexes = await indexesOf(collection);
    } catch {
      // NamespaceNotFound: nothing exists yet, so nothing can conflict.
    }
    if (hasIndexOnKeys(indexes, spec.key)) {
      log.info("Index already present, skipping", {
        collection: spec.collection,
        key: spec.key,
      });
      continue;
    }
    await collection.createIndex(spec.key, spec.options ?? {});
    log.info("Created index", {
      collection: spec.collection,
      key: spec.key,
      why: spec.why,
    });
  }
}
