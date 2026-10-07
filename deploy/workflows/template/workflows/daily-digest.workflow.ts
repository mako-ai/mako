// Scheduled example: Hatchet fires it every weekday at 07:00 UTC.
import { hatchet } from "./hatchet";

export const dailyDigest = hatchet.workflow({
  name: "daily-digest",
  on: { cron: "0 7 * * 1-5" },
});

dailyDigest.task({
  name: "build-digest",
  retries: 1,
  fn: async () => ({
    date: new Date().toISOString().slice(0, 10),
    items: [] as string[],
  }),
});
