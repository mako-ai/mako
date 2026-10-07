// AI example: a short read-only agent in one task, using Mako's data tools.
import { generateText, stepCountIs } from "ai";
import { hatchet } from "./hatchet";
import { model, tools } from "./lib/mako";

type Input = { company: string };

export const enrichLead = hatchet.workflow<Input>({ name: "enrich-lead" });

enrichLead.task({
  name: "research",
  retries: 1,
  executionTimeout: "5m",
  fn: async input => {
    const { text, usage } = await generateText({
      model: model("anthropic/claude-sonnet-5-5"),
      tools: await tools(),
      stopWhen: stepCountIs(8),
      prompt: `Research ${input.company} using the available tools and summarize useful sales context.`,
    });
    return { summary: text, tokens: usage.totalTokens ?? 0 };
  },
});
