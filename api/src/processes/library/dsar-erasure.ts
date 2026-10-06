/**
 * DSAR erasure — the first reference process.
 *
 * Investigate (agent, read-only) → plan (agent, structured) → confirm identity
 * if unsure (task) → approve plan (approval, editable) → execute (one
 * deterministic step per system, destructive calls ledgered) → verify (agent)
 * → report (artifact) → confirm to the requester (email).
 */
import { defineProcess, trigger, z, type StepContext } from "../sdk";
import { emailSend } from "../tools/mako";
import { sample } from "../tools/sample-systems";

const System = z.enum(["crm", "marketing", "support", "billing"]);

const Findings = z.object({
  identityConfidence: z.enum(["high", "medium", "low"]),
  records: z.array(
    z.object({
      system: System,
      recordId: z.string(),
      matchedOn: z.string().describe("e.g. 'exact email', 'name + company'"),
      dataCategories: z.array(z.string()),
      notes: z.string().optional(),
    }),
  ),
  openQuestions: z.array(z.string()),
});

const Plan = z.object({
  identityConfidence: z.enum(["high", "medium", "low"]),
  systems: z.array(
    z.object({
      system: System,
      recordIds: z.array(z.string()),
      dataCategories: z.array(z.string()),
      proposedAction: z.enum(["delete", "redact", "suppress", "retain"]),
      reason: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});
type Plan = z.infer<typeof Plan>;

const Verification = z.object({
  complete: z.boolean(),
  remaining: z.array(
    z.object({ system: System, recordId: z.string(), detail: z.string() }),
  ),
  summary: z.string(),
});

const readTools = [
  sample.crmContactSearch,
  sample.marketingContactLookup,
  sample.supportTicketSearch,
  sample.billingCustomerLookup,
];

/** How each approved action is carried out. Deterministic: no model here. */
async function execute(s: StepContext, item: Plan["systems"][number]) {
  const results: unknown[] = [];
  for (const recordId of item.recordIds) {
    if (item.system === "crm" && item.proposedAction === "delete") {
      results.push(
        await s.call(sample.crmContactDelete, { contactId: recordId }),
      );
    } else if (item.system === "support" && item.proposedAction === "redact") {
      results.push(
        await s.call(sample.supportTicketRedact, { ticketId: recordId }),
      );
    } else if (
      item.system === "marketing" &&
      item.proposedAction === "suppress"
    ) {
      results.push(
        await s.call(sample.marketingContactSuppress, { email: recordId }),
      );
    } else {
      s.log(
        `No executor for ${item.proposedAction} in ${item.system}; skipped`,
        { recordId },
      );
    }
  }
  return results;
}

export default defineProcess({
  id: "dsar-erasure",
  name: "DSAR erasure",
  description:
    "Find a data subject across systems, plan the erasure, get it approved, execute, verify and confirm.",
  category: "compliance",
  triggers: [trigger.manual(), trigger.event("dsar.requested")],
  input: z.object({
    requestId: z.string(),
    email: z.string().email(),
    name: z.string().optional(),
    replyTo: z.string().email().optional(),
  }),
  tools: [
    ...readTools,
    sample.crmContactDelete,
    sample.supportTicketRedact,
    sample.marketingContactSuppress,
    emailSend,
  ],

  run: async (ctx, input) => {
    const findings = await ctx.agent("Investigate subject", {
      instructions:
        "You are a privacy analyst handling a GDPR Art. 17 erasure request. Find every " +
        "record about the data subject in every available system. Search by exact email " +
        "first, then by name to catch alternate addresses; only include name matches you " +
        "can tie to the subject (same company, same phone…) and say how you matched. " +
        "Never modify anything.",
      prompt: { subject: { email: input.email, name: input.name } },
      tools: readTools,
      output: Findings,
    });

    const plan = await ctx.agent("Create action plan", {
      instructions:
        "Turn the findings into an erasure plan, one entry per system. Policy: CRM contacts " +
        "→ delete; support tickets → redact; marketing → suppress (keeping the address on " +
        "the suppression list is required to honour the opt-out); billing → retain (statutory " +
        "retention) and say so. Use the record ids exactly as found (marketing uses the email " +
        "as id). Add a warning for anything uncertain.",
      prompt: { request: input, findings },
      output: Plan,
    });

    if (plan.identityConfidence === "low") {
      const identity = await ctx.task("Confirm subject identity", {
        description:
          "The investigation could not confidently tie all records to the requester. " +
          "Confirm identity (e.g. via the request channel) before anything is erased.",
        form: z.object({
          confirmed: z.boolean().describe("The requester is the data subject"),
          note: z.string().optional(),
        }),
      });
      if (!identity.data.confirmed) {
        return {
          requestId: input.requestId,
          outcome: "identity-not-confirmed" as const,
        };
      }
    }

    const review = await ctx.approval("Approve erasure plan", {
      data: plan,
      schema: Plan,
      description: `Erasure request **${input.requestId}** for \`${input.email}\`. Remove anything that should not be touched.`,
    });
    if (!review.approved) {
      return {
        requestId: input.requestId,
        outcome: review.outcome,
        comment: review.comment,
      };
    }

    const actionable = review.data.systems.filter(
      item => item.proposedAction !== "retain",
    );
    for (const item of actionable) {
      await ctx.step(
        `${item.proposedAction} in ${item.system}`,
        s => execute(s, item),
        {
          retries: 2,
        },
      );
    }

    const verification = await ctx.agent("Verify erasure", {
      instructions:
        "Check every system again for the data subject. Report anything that still holds " +
        "personal data, except records the plan deliberately retained.",
      prompt: { subject: input, approvedPlan: review.data },
      tools: readTools,
      output: Verification,
    });

    const report = await ctx.step("Write report", async s => {
      const lines = [
        `# Erasure report — ${input.requestId}`,
        ``,
        `Subject: ${input.email}${input.name ? ` (${input.name})` : ""}`,
        `Approved by: ${review.by?.email ?? review.by?.id ?? "unknown"} at ${review.at}`,
        ``,
        `| System | Action | Records | Reason |`,
        `|---|---|---|---|`,
        ...review.data.systems.map(
          i =>
            `| ${i.system} | ${i.proposedAction} | ${i.recordIds.length} | ${i.reason} |`,
        ),
        ``,
        `Verification: ${verification.complete ? "complete" : "INCOMPLETE"} — ${verification.summary}`,
      ];
      await s.artifact("erasure-report.md", lines.join("\n"), {
        mimeType: "text/markdown",
      });
      return { complete: verification.complete };
    });

    if (input.replyTo && report.complete) {
      await ctx.step("Send confirmation", s =>
        s.call(emailSend, {
          to: [input.replyTo as string],
          subject: `Your data erasure request ${input.requestId}`,
          text:
            "We have completed your erasure request. Records we are legally required to " +
            "keep (billing) have been restricted and will be deleted when the retention " +
            "period ends.",
        }),
      );
    }

    return {
      requestId: input.requestId,
      outcome: report.complete
        ? ("erased" as const)
        : ("needs-attention" as const),
      remaining: verification.remaining,
    };
  },
});
