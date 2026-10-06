/**
 * Lead enrichment with human review (vibe-code test #2).
 *
 * An agent researches each new lead, proposes a fit score and a
 * qualify/disqualify decision; a person reviews (and may edit) the batch;
 * approved decisions are written back to the CRM.
 */
import { defineProcess, trigger, z } from "../sdk";
import { webFetch, webSearch } from "../tools/mako";
import { sample } from "../tools/sample-systems";

const Enrichment = z.object({
  leadId: z.string(),
  company: z.string().optional(),
  title: z.string().optional(),
  segment: z.enum(["enterprise", "mid-market", "smb", "consumer", "unknown"]),
  fitScore: z.number().min(0).max(100),
  decision: z.enum(["qualified", "disqualified"]),
  reasoning: z.string(),
});

const Review = z.object({ leads: z.array(Enrichment) });

export default defineProcess({
  id: "lead-enrichment",
  name: "Lead enrichment",
  description:
    "Research new leads, score fit, have a human review, then update the CRM.",
  category: "sales",
  triggers: [trigger.manual(), trigger.event("lead.batch_ready")],
  input: z.object({
    idealCustomerProfile: z
      .string()
      .default(
        "Data teams at companies with 200+ employees in finance, logistics or SaaS.",
      ),
  }),
  tools: [sample.crmLeadList, sample.crmLeadUpdate, webSearch, webFetch],

  run: async (ctx, input) => {
    const leads = await ctx.step(
      "Load new leads",
      async s => (await s.call(sample.crmLeadList, { status: "new" })).leads,
    );
    if (leads.length === 0) return { reviewed: 0 };

    const enriched = await Promise.all(
      leads.map(lead =>
        ctx.agent(`Research ${lead.name}`, {
          instructions:
            "You qualify inbound leads. Research the person and company (web search may be " +
            "unavailable — then reason from the email domain and the CRM fields). Score fit " +
            `against this ICP: ${input.idealCustomerProfile}. Personal email domains with no ` +
            "company are usually disqualified. Be concise.",
          prompt: lead,
          tools: [webSearch, webFetch],
          output: Enrichment,
          maxIterations: 8,
        }),
      ),
    );

    const review = await ctx.approval("Review lead decisions", {
      data: { leads: enriched },
      schema: Review,
      description:
        "Edit scores or decisions before they are written to the CRM.",
    });
    if (!review.approved) return { reviewed: enriched.length, written: 0 };

    for (const lead of review.data.leads) {
      await ctx.step(`Update ${lead.leadId}`, s =>
        s.call(sample.crmLeadUpdate, {
          leadId: lead.leadId,
          status: lead.decision,
          score: lead.fitScore,
          enrichment: {
            company: lead.company,
            title: lead.title,
            segment: lead.segment,
          },
        }),
      );
    }
    return { reviewed: enriched.length, written: review.data.leads.length };
  },
});
