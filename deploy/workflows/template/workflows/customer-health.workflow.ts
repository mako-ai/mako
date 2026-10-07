// Sequential example: fetch, then score. Every task retries once so a crashed
// worker never loses a run (Hatchet reassigns the task to the new worker).
import { hatchet } from "./hatchet";
import { query } from "./lib/mako";

type Input = { connection: string; limit?: number };

export const customerHealth = hatchet.workflow<Input>({
  name: "customer-health",
});

const fetchCustomers = customerHealth.task({
  name: "fetch-customers",
  retries: 2,
  fn: async input => ({
    result: await query(
      input.connection,
      `select * from customers limit ${input.limit ?? 100}`,
    ),
  }),
});

customerHealth.task({
  name: "summarize",
  parents: [fetchCustomers],
  retries: 1,
  fn: async (_input, ctx) => {
    const { result } = await ctx.parentOutput(fetchCustomers);
    return {
      fetchedAt: new Date().toISOString(),
      preview: JSON.stringify(result).slice(0, 500),
    };
  },
});
