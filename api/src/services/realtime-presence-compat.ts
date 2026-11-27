import mongoose, { Schema, type Model, type Types } from "mongoose";
import { isObjectIdHex } from "../database/pg/id-codec";

interface LegacyPresence {
  workspaceId: Types.ObjectId;
  clientId: string;
  userId: string;
  lastSeenAt: Date;
}

let model: Model<LegacyPresence> | undefined;

// One-release bridge for SSE connections and chat requests served by different
// revisions. Disable after the last Mongo-only revision has drained.
function legacyModel(workspaceId: string): Model<LegacyPresence> | undefined {
  if (
    !process.env.DATABASE_URL ||
    process.env.REALTIME_PRESENCE_MONGO_COMPAT === "false" ||
    !isObjectIdHex(workspaceId)
  ) {
    return undefined;
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error("Legacy presence connection unavailable");
  }
  if (!model) {
    const schema = new Schema<LegacyPresence>(
      {
        workspaceId: { type: Schema.Types.ObjectId, required: true },
        clientId: { type: String, required: true },
        userId: { type: String, required: true },
        lastSeenAt: { type: Date, required: true },
      },
      { collection: "realtime_presence", bufferCommands: false },
    );
    schema.index({ workspaceId: 1, clientId: 1 }, { unique: true });
    schema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 });
    model = mongoose.model<LegacyPresence>("LegacyRealtimePresence", schema);
  }
  return model;
}

export async function touchLegacyPresence(
  workspaceId: string,
  clientId: string,
  userId: string,
  now: number,
): Promise<void> {
  await legacyModel(workspaceId)
    ?.updateOne(
      { workspaceId, clientId },
      { $set: { lastSeenAt: new Date(now), userId } },
      { upsert: true, timeoutMS: 2000 },
    )
    .exec();
}

export async function clearLegacyPresence(
  workspaceId: string,
  clientId: string,
): Promise<void> {
  await legacyModel(workspaceId)
    ?.deleteOne({ workspaceId, clientId }, { timeoutMS: 2000 })
    .exec();
}

export async function hasFreshLegacyPresence(
  workspaceId: string,
  since: number,
): Promise<boolean> {
  return Boolean(
    await legacyModel(workspaceId)
      ?.exists({
        workspaceId,
        lastSeenAt: { $gte: new Date(since) },
      })
      .setOptions({ timeoutMS: 2000 })
      .exec(),
  );
}
