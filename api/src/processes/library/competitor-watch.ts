/**
 * Weekly competitor watch (vibe-code test #3).
 *
 * Every Friday: one agent per competitor reads their public pages and news,
 * a second agent compares with last week's findings and writes a brief, and
 * the brief is emailed and kept as an artifact.
 */
import { defineProcess, trigger, z } from "../sdk";
import { emailSend, webFetch, webSearch } from "../tools/mako";

const Competitor = z.object({
  name: z.string(),
  urls: z.array(z.string().url()).max(5),
});

const Findings = z.object({
  competitor: z.string(),
  pricing: z.string().optional(),
  launches: z.array(z.string()),
  messaging: z.string(),
  sources: z.array(z.string()),
});

const Brief = z.object({
  headline: z.string(),
  changes: z.array(
    z.object({
      competitor: z.string(),
      change: z.string(),
      soWhat: z.string(),
    }),
  ),
  markdown: z.string(),
});

const Input = z.object({
  competitors: z.array(Competitor).min(1),
  recipients: z.array(z.string().email()).min(1),
});

export default defineProcess({
  id: "competitor-watch",
  name: "Weekly competitor watch",
  description:
    "Track competitors' pages and news weekly and email what changed.",
  category: "marketing",
  triggers: [
    trigger.schedule("0 8 * * 5", {
      input: {
        competitors: [{ name: "Example Co", urls: ["https://example.com"] }],
        recipients: ["product@example.com"],
      },
    }),
    trigger.manual(),
  ],
  input: Input,
  tools: [webSearch, webFetch, emailSend],

  run: async (ctx, input) => {
    const findings = await Promise.all(
      input.competitors.map(competitor =>
        ctx.agent(`Research ${competitor.name}`, {
          instructions:
            "Read the competitor's pages (and search for news from the last 7 days if " +
            "search is available). Report pricing, launches and positioning, with sources.",
          prompt: competitor,
          tools: [webFetch, webSearch],
          output: Findings,
          maxIterations: 10,
        }),
      ),
    );

    // What did we report last week? (The previous completed run's output.)
    const lastWeek = await ctx.step("Load last week", s =>
      s.previousOutput<{ findings?: unknown }>(),
    );

    const brief = await ctx.agent("Write brief", {
      instructions:
        "Compare this week's findings with last week's. Lead with what changed and why it " +
        "matters for us; skip anything unchanged. Keep the markdown under 300 words.",
      prompt: { thisWeek: findings, lastWeek: lastWeek?.findings ?? null },
      output: Brief,
    });

    await ctx.step("Publish brief", async s => {
      await s.artifact("competitor-brief.md", brief.markdown, {
        mimeType: "text/markdown",
      });
      return s.call(emailSend, {
        to: input.recipients,
        subject: `Competitor watch: ${brief.headline}`,
        text: brief.markdown,
      });
    });

    return { findings, headline: brief.headline };
  },
});
