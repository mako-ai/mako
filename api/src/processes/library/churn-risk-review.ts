/**
 * Weekly churn-risk review (vibe-code test #1).
 *
 * Every Monday: find accounts whose usage is low or falling, have an agent
 * investigate each one in parallel, score churn risk, and email each CSM a
 * recommended action plan for their accounts.
 */
import { defineProcess, trigger, z } from "../sdk";
import { emailSend } from "../tools/mako";
import { sample } from "../tools/sample-systems";

const Assessment = z.object({
  accountId: z.string(),
  riskScore: z.number().min(0).max(100),
  drivers: z.array(z.string()),
  recommendedActions: z.array(z.string()).max(5),
});

export default defineProcess({
  id: "churn-risk-review",
  name: "Weekly churn-risk review",
  description:
    "Every Monday, investigate low-usage accounts, score churn risk and send each CSM an action plan.",
  category: "customer-success",
  triggers: [
    trigger.schedule("0 7 * * 1", { timezone: "Europe/Zurich", input: {} }),
    trigger.manual(),
  ],
  input: z.object({
    /** Flag accounts whose latest WAU is below this share of seats. */
    usageThreshold: z.number().min(0).max(1).default(0.5),
  }),
  tools: [
    sample.crmAccountList,
    sample.productUsageWeekly,
    sample.supportTicketSearch,
    emailSend,
  ],

  run: async (ctx, input) => {
    const atRisk = await ctx.step("Find low-usage accounts", async s => {
      const { accounts } = await s.call(sample.crmAccountList, {});
      const flagged = [];
      for (const account of accounts) {
        const { weeklyActiveUsers: wau } = await s.call(
          sample.productUsageWeekly,
          {
            accountId: account.id,
          },
        );
        const latest = wau.at(-1) ?? 0;
        const falling = wau.length > 2 && latest < wau[0] * 0.7;
        if (latest < account.seats * input.usageThreshold || falling) {
          flagged.push({ ...account, weeklyActiveUsers: wau });
        }
      }
      s.log(`${flagged.length} of ${accounts.length} accounts flagged`);
      return flagged;
    });

    const assessments = await Promise.all(
      atRisk.map(account =>
        ctx.agent(`Assess ${account.name}`, {
          instructions:
            "You are a customer-success analyst. Using the usage trend and anything else " +
            "you can find, score this account's churn risk (0–100), name the drivers, and " +
            "recommend at most 5 concrete actions for the CSM this week.",
          prompt: account,
          tools: [sample.productUsageWeekly],
          output: Assessment,
          maxIterations: 6,
        }),
      ),
    );

    const byCsm = new Map<string, typeof assessments>();
    for (const assessment of assessments) {
      const csm = atRisk.find(a => a.id === assessment.accountId)?.csmEmail;
      if (!csm) continue;
      byCsm.set(csm, [...(byCsm.get(csm) ?? []), assessment]);
    }

    for (const [csm, items] of byCsm) {
      await ctx.step(`Email ${csm}`, s =>
        s.call(emailSend, {
          to: [csm],
          subject: `Churn risk this week: ${items.length} account(s)`,
          text: items
            .sort((a, b) => b.riskScore - a.riskScore)
            .map(
              a =>
                `${atRisk.find(x => x.id === a.accountId)?.name} — risk ${a.riskScore}\n` +
                `Drivers: ${a.drivers.join("; ")}\n` +
                a.recommendedActions.map(x => `  • ${x}`).join("\n"),
            )
            .join("\n\n"),
        }),
      );
    }

    return { flagged: atRisk.length, emailed: byCsm.size, assessments };
  },
});
