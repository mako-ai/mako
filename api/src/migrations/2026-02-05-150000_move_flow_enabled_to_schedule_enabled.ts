import { Db } from "mongodb";

export const description =
  "Move flow enabled flag into schedule.enabled and remove root enabled";

export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");

  // Ensure scheduled flows with existing schedules get schedule.enabled set
  await flows.updateMany(
    {
      type: "scheduled",
      schedule: { $exists: true },
      "schedule.enabled": { $exists: false },
    },
    [
      {
        $set: {
          "schedule.enabled": { $ifNull: ["$enabled", true] },
        },
      },
    ],
  );

  // Ensure scheduled flows without schedules get a disabled schedule
  await flows.updateMany(
    {
      type: "scheduled",
      schedule: { $exists: false },
    },
    {
      $set: {
        schedule: {
          enabled: false,
        },
      },
    },
  );

  // Remove legacy root enabled flag
  await flows.updateMany(
    { enabled: { $exists: true } },
    { $unset: { enabled: "" } },
  );
}
