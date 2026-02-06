import { Db } from "mongodb";

export const description =
  'Rename legacy conflictConfig.strategy "upsert" to "update" in flows';

export async function up(db: Db): Promise<void> {
  const result = await db
    .collection("flows")
    .updateMany(
      { "conflictConfig.strategy": "upsert" },
      { $set: { "conflictConfig.strategy": "update" } },
    );

  if (result.modifiedCount > 0) {
    // Using stdout here because migration runner captures output
    // eslint-disable-next-line no-console
    console.log(
      `Normalized ${result.modifiedCount} flow(s) from "upsert" to "update"`,
    );
  }
}
