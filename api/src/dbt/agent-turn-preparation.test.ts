import { describe, expect, it } from "vitest";

import {
  MAX_SKILL_EXCERPT_CHARS,
  renderCompactSkillBlock,
} from "../services/agent-turn-preparation.service";

describe("renderCompactSkillBlock", () => {
  it("injects one relevant skill within the turn budget", () => {
    const body = "x".repeat(MAX_SKILL_EXCERPT_CHARS * 2);
    const block = renderCompactSkillBlock({
      injected: [
        {
          id: "one",
          name: "dbt",
          loadWhen: "Use for dbt",
          body,
          score: 1,
          entityOverlap: 1,
          semanticScore: 0,
          injected: true,
          scope: "system",
        },
        {
          id: "two",
          name: "unrelated",
          loadWhen: "Use elsewhere",
          body: "must not be injected",
          score: 0.9,
          entityOverlap: 1,
          semanticScore: 0,
          injected: true,
          scope: "system",
        },
      ],
    });

    expect(block).toContain("`dbt`");
    expect(block).toContain("Excerpt truncated");
    expect(block).not.toContain("must not be injected");
    expect(block.length).toBeLessThan(MAX_SKILL_EXCERPT_CHARS + 500);
  });

  it("returns no block when retrieval selected no skill", () => {
    expect(renderCompactSkillBlock({ injected: [] })).toBe("");
  });
});
