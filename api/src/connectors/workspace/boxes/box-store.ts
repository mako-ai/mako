/**
 * Durable records of connector boxes and their leases (RFC connector-runtime
 * §6.8): one document per box, one per snapshot template.
 *
 * Every state change is a compare-and-set on (state, leasedBy), so two API
 * instances, or a run and the reaper, can never both act on one box: the
 * loser's update matches nothing and it moves on.
 */
import mongoose, { Schema } from "mongoose";

/**
 * leased -> idle -> pausing -> paused -> (leased | killing -> killed).
 * `pausing` and `killing` are claimed before the provider call, so a lease
 * can never pick up a box the reaper is in the middle of pausing or killing.
 */
export type BoxState =
  "leased" | "idle" | "pausing" | "paused" | "killing" | "killed";

export const LIVE_BOX_STATES: readonly BoxState[] = [
  "leased",
  "idle",
  "pausing",
  "paused",
  "killing",
];

export interface BoxRecord {
  boxId: string;
  /** connectionId + bundle hash. Boxes are never shared across keys. */
  key: string;
  workspaceId: string;
  connectionId: string;
  bundleHash: string;
  state: BoxState;
  leasedBy: string | null;
  leasedAt: Date | null;
  heartbeatAt: Date | null;
  deadline: Date | null;
  createdAt: Date;
  lastUsedAt: Date;
  /** The connection's previous run before `lastUsedAt`; picks the TTL. */
  priorUseAt: Date | null;
  failures: number;
  runs: number;
  /** Seconds this box spent leased, for cost per workspace and connection. */
  boxSeconds: number;
  /** A newer bundle hash exists for the connection, or the box is one-off. */
  draining: boolean;
  /** The SDK runtime the box holds; part of the template key. */
  runtimeId: string | null;
  /** Snapshot this box was restored from, if any. */
  fromTemplate: string | null;
  stateChangedAt: Date;
  killedAt: Date | null;
  killReason: string | null;
}

export interface TemplateRecord {
  templateKey: string;
  snapshotId: string;
  createdAt: Date;
  lastUsedAt: Date;
}

/** A reusable box taken by a lease, and the state it was taken from. */
export interface Claimed {
  box: BoxRecord;
  from: "idle" | "paused";
}

export interface BoxCounters {
  failures?: number;
  runs?: number;
  boxSeconds?: number;
}

export interface BoxStore {
  insert(record: BoxRecord): Promise<void>;
  get(boxId: string): Promise<BoxRecord | null>;
  /**
   * Take a reusable box for this key: idle before paused, most recently used
   * first, never a draining one. Atomic: one caller wins each box.
   */
  claimReusable(
    key: string,
    runId: string,
    patch: Pick<BoxRecord, "leasedAt" | "heartbeatAt" | "deadline">,
    states?: readonly ("idle" | "paused")[],
  ): Promise<Claimed | null>;
  countLeased(key: string): Promise<number>;
  /** Compare-and-set. Returns the updated record, or null if `expect` failed. */
  transition(
    boxId: string,
    expect: Partial<Pick<BoxRecord, "state" | "leasedBy" | "lastUsedAt">>,
    set: Partial<BoxRecord>,
    inc?: BoxCounters,
  ): Promise<BoxRecord | null>;
  /** Every box not yet killed. */
  listLive(): Promise<BoxRecord[]>;
  /** Most recent use of any box of this connection. */
  latestUse(connectionId: string): Promise<Date | null>;
  /** Mark boxes of this connection on other hashes as draining. */
  drainOtherHashes(connectionId: string, bundleHash: string): Promise<number>;
  getTemplate(templateKey: string): Promise<TemplateRecord | null>;
  putTemplate(record: TemplateRecord): Promise<void>;
  touchTemplate(templateKey: string, at: Date): Promise<void>;
  staleTemplates(before: Date): Promise<TemplateRecord[]>;
  deleteTemplate(templateKey: string): Promise<void>;
}

// ── Mongo ──────────────────────────────────────────────────────────────────

const ConnectorBoxSchema = new Schema<BoxRecord>(
  {
    boxId: { type: String, required: true },
    key: { type: String, required: true },
    workspaceId: { type: String, required: true },
    connectionId: { type: String, required: true },
    bundleHash: { type: String, required: true },
    state: { type: String, required: true },
    leasedBy: { type: String, default: null },
    leasedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    deadline: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    priorUseAt: { type: Date, default: null },
    failures: { type: Number, default: 0 },
    runs: { type: Number, default: 0 },
    boxSeconds: { type: Number, default: 0 },
    draining: { type: Boolean, default: false },
    runtimeId: { type: String, default: null },
    fromTemplate: { type: String, default: null },
    stateChangedAt: { type: Date, required: true },
    killedAt: { type: Date, default: null },
    killReason: { type: String, default: null },
  },
  { collection: "connector_boxes", versionKey: false },
);

ConnectorBoxSchema.index({ boxId: 1 }, { unique: true });
ConnectorBoxSchema.index({ key: 1, state: 1 });
ConnectorBoxSchema.index({ state: 1 });
ConnectorBoxSchema.index({ connectionId: 1, lastUsedAt: -1 });
// Killed boxes stay a week for the record (box-seconds, kill reasons).
ConnectorBoxSchema.index(
  { killedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

const ConnectorBoxTemplateSchema = new Schema<TemplateRecord>(
  {
    templateKey: { type: String, required: true },
    snapshotId: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
  },
  { collection: "connector_box_templates", versionKey: false },
);
ConnectorBoxTemplateSchema.index({ templateKey: 1 }, { unique: true });
ConnectorBoxTemplateSchema.index({ lastUsedAt: 1 });

export const ConnectorBox =
  (mongoose.models.ConnectorBox as mongoose.Model<BoxRecord>) ??
  mongoose.model<BoxRecord>("ConnectorBox", ConnectorBoxSchema);

export const ConnectorBoxTemplate =
  (mongoose.models.ConnectorBoxTemplate as mongoose.Model<TemplateRecord>) ??
  mongoose.model<TemplateRecord>(
    "ConnectorBoxTemplate",
    ConnectorBoxTemplateSchema,
  );

type Lean<T> = T & { _id?: unknown };
const strip = <T>(doc: Lean<T> | null): T | null => {
  if (!doc) return null;
  const { _id: _ignored, ...rest } = doc;
  return rest as T;
};

function incUpdate(inc?: BoxCounters): Record<string, number> | undefined {
  if (!inc) return undefined;
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(inc)) {
    if (typeof value === "number" && value !== 0) out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class MongoBoxStore implements BoxStore {
  async insert(record: BoxRecord): Promise<void> {
    await ConnectorBox.create(record);
  }

  async get(boxId: string): Promise<BoxRecord | null> {
    return strip(await ConnectorBox.findOne({ boxId }).lean<BoxRecord>());
  }

  async claimReusable(
    key: string,
    runId: string,
    patch: Pick<BoxRecord, "leasedAt" | "heartbeatAt" | "deadline">,
    states: readonly ("idle" | "paused")[] = ["idle", "paused"],
  ): Promise<Claimed | null> {
    const now = new Date();
    for (const state of states) {
      const doc = await ConnectorBox.findOneAndUpdate(
        { key, state, leasedBy: null, draining: { $ne: true } },
        {
          $set: {
            ...patch,
            state: "leased",
            leasedBy: runId,
            stateChangedAt: now,
          },
        },
        { sort: { lastUsedAt: -1 }, returnDocument: "after" },
      ).lean<BoxRecord>();
      if (doc) return { box: strip(doc) as BoxRecord, from: state };
    }
    return null;
  }

  async countLeased(key: string): Promise<number> {
    return ConnectorBox.countDocuments({ key, state: "leased" });
  }

  async transition(
    boxId: string,
    expect: Partial<Pick<BoxRecord, "state" | "leasedBy" | "lastUsedAt">>,
    set: Partial<BoxRecord>,
    inc?: BoxCounters,
  ): Promise<BoxRecord | null> {
    const update: Record<string, unknown> = {
      $set: set.state ? { ...set, stateChangedAt: new Date() } : set,
    };
    const $inc = incUpdate(inc);
    if ($inc) update.$inc = $inc;
    return strip(
      await ConnectorBox.findOneAndUpdate({ boxId, ...expect }, update, {
        returnDocument: "after",
      }).lean<BoxRecord>(),
    );
  }

  async listLive(): Promise<BoxRecord[]> {
    const docs = await ConnectorBox.find({
      state: { $in: LIVE_BOX_STATES },
    }).lean<BoxRecord[]>();
    return docs.map(doc => strip(doc) as BoxRecord);
  }

  async latestUse(connectionId: string): Promise<Date | null> {
    const doc = await ConnectorBox.findOne({ connectionId })
      .sort({ lastUsedAt: -1 })
      .select({ lastUsedAt: 1 })
      .lean<Pick<BoxRecord, "lastUsedAt">>();
    return doc?.lastUsedAt ?? null;
  }

  async drainOtherHashes(
    connectionId: string,
    bundleHash: string,
  ): Promise<number> {
    const result = await ConnectorBox.updateMany(
      {
        connectionId,
        bundleHash: { $ne: bundleHash },
        state: { $in: LIVE_BOX_STATES },
        draining: { $ne: true },
      },
      { $set: { draining: true } },
    );
    return result.modifiedCount;
  }

  async getTemplate(templateKey: string): Promise<TemplateRecord | null> {
    return strip(
      await ConnectorBoxTemplate.findOne({
        templateKey,
      }).lean<TemplateRecord>(),
    );
  }

  async putTemplate(record: TemplateRecord): Promise<void> {
    await ConnectorBoxTemplate.updateOne(
      { templateKey: record.templateKey },
      { $set: record },
      { upsert: true },
    );
  }

  async touchTemplate(templateKey: string, at: Date): Promise<void> {
    await ConnectorBoxTemplate.updateOne(
      { templateKey },
      { $set: { lastUsedAt: at } },
    );
  }

  async staleTemplates(before: Date): Promise<TemplateRecord[]> {
    const docs = await ConnectorBoxTemplate.find({
      lastUsedAt: { $lt: before },
    }).lean<TemplateRecord[]>();
    return docs.map(doc => strip(doc) as TemplateRecord);
  }

  async deleteTemplate(templateKey: string): Promise<void> {
    await ConnectorBoxTemplate.deleteOne({ templateKey });
  }
}

// ── In-process (tests, and the same semantics as Mongo) ────────────────────

export class MemoryBoxStore implements BoxStore {
  readonly boxes = new Map<string, BoxRecord>();
  readonly templates = new Map<string, TemplateRecord>();

  async insert(record: BoxRecord): Promise<void> {
    if (this.boxes.has(record.boxId)) throw new Error("duplicate boxId");
    this.boxes.set(record.boxId, { ...record });
  }

  async get(boxId: string): Promise<BoxRecord | null> {
    const box = this.boxes.get(boxId);
    return box ? { ...box } : null;
  }

  async claimReusable(
    key: string,
    runId: string,
    patch: Pick<BoxRecord, "leasedAt" | "heartbeatAt" | "deadline">,
    states: readonly ("idle" | "paused")[] = ["idle", "paused"],
  ): Promise<Claimed | null> {
    for (const state of states) {
      const [box] = [...this.boxes.values()]
        .filter(
          b =>
            b.key === key &&
            b.state === state &&
            b.leasedBy === null &&
            !b.draining,
        )
        .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
      if (box) {
        Object.assign(box, patch, {
          state: "leased",
          leasedBy: runId,
          stateChangedAt: new Date(),
        });
        return { box: { ...box }, from: state };
      }
    }
    return null;
  }

  async countLeased(key: string): Promise<number> {
    return [...this.boxes.values()].filter(
      b => b.key === key && b.state === "leased",
    ).length;
  }

  async transition(
    boxId: string,
    expect: Partial<Pick<BoxRecord, "state" | "leasedBy" | "lastUsedAt">>,
    set: Partial<BoxRecord>,
    inc?: BoxCounters,
  ): Promise<BoxRecord | null> {
    const box = this.boxes.get(boxId);
    if (!box) return null;
    for (const [field, value] of Object.entries(expect)) {
      const current = box[field as keyof BoxRecord];
      const same =
        value instanceof Date && current instanceof Date
          ? value.getTime() === current.getTime()
          : current === value;
      if (!same) return null;
    }
    Object.assign(box, set);
    if (set.state) box.stateChangedAt = new Date();
    for (const [field, value] of Object.entries(inc ?? {})) {
      (box as unknown as Record<string, number>)[field] += value ?? 0;
    }
    return { ...box };
  }

  async listLive(): Promise<BoxRecord[]> {
    return [...this.boxes.values()]
      .filter(b => b.state !== "killed")
      .map(b => ({ ...b }));
  }

  async latestUse(connectionId: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const box of this.boxes.values()) {
      if (box.connectionId !== connectionId) continue;
      if (!latest || box.lastUsedAt > latest) latest = box.lastUsedAt;
    }
    return latest;
  }

  async drainOtherHashes(
    connectionId: string,
    bundleHash: string,
  ): Promise<number> {
    let count = 0;
    for (const box of this.boxes.values()) {
      if (
        box.connectionId === connectionId &&
        box.bundleHash !== bundleHash &&
        box.state !== "killed" &&
        !box.draining
      ) {
        box.draining = true;
        count++;
      }
    }
    return count;
  }

  async getTemplate(templateKey: string): Promise<TemplateRecord | null> {
    const template = this.templates.get(templateKey);
    return template ? { ...template } : null;
  }

  async putTemplate(record: TemplateRecord): Promise<void> {
    this.templates.set(record.templateKey, { ...record });
  }

  async touchTemplate(templateKey: string, at: Date): Promise<void> {
    const template = this.templates.get(templateKey);
    if (template) template.lastUsedAt = at;
  }

  async staleTemplates(before: Date): Promise<TemplateRecord[]> {
    return [...this.templates.values()]
      .filter(t => t.lastUsedAt < before)
      .map(t => ({ ...t }));
  }

  async deleteTemplate(templateKey: string): Promise<void> {
    this.templates.delete(templateKey);
  }
}
