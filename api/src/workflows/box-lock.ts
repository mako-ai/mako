/**
 * One sandbox run at a time per box, across every API process: two embedded
 * engines cannot share one data folder. A lease in Mongo (every replica
 * reaches it; Redis is optional): the holder renews it while its run goes on,
 * and a holder that died stops renewing, so its lease runs out and the next
 * run takes the box. The next run's `run.mjs` then stops whatever the dead
 * holder left running in the box.
 */
import mongoose, { Schema } from "mongoose";

interface IBoxLock {
  _id: string;
  holder: string;
  expiresAt: Date;
}

const BoxLockSchema = new Schema<IBoxLock>(
  {
    _id: { type: String, required: true },
    holder: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "workflow_box_locks", versionKey: false },
);

export const BoxLock =
  (mongoose.models.WorkflowBoxLock as mongoose.Model<IBoxLock>) ??
  mongoose.model<IBoxLock>("WorkflowBoxLock", BoxLockSchema);

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number } | null)?.code === 11000;

/**
 * Take the box's lease for `holder`, or renew it when `holder` has it.
 * False while another holder's lease is current.
 */
export async function acquireBoxLock(
  box: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  try {
    // Matches a lease that ran out or is ours; with none to match, the upsert
    // inserts one, and that insert fails on the _id when another holder has a
    // current lease.
    await BoxLock.updateOne(
      { _id: box, $or: [{ expiresAt: { $lte: now } }, { holder }] },
      { $set: { holder, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

/** Push the lease out. False when it is no longer `holder`'s. */
export async function renewBoxLock(
  box: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await BoxLock.updateOne(
    { _id: box, holder },
    { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
  );
  return result.matchedCount === 1;
}

/** Give the box back; a no-op when `holder` no longer has it. */
export async function releaseBoxLock(box: string, holder: string) {
  await BoxLock.deleteOne({ _id: box, holder });
}
