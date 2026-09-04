import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_EXCERPT_CHARS,
  renderCompactSkillBlock,
} from "../services/agent-turn-preparation.service";

describe("renderCompactSkillBlock", () => {
  it("renders every pinned skill, each within the excerpt budget", () => {
    const long = "x".repeat(MAX_SKILL_EXCERPT_CHARS * 2);
    const block = renderCompactSkillBlock({
      injected: [
        {
          id: "one",
          name: "warehouse_map",
          loadWhen: "Every warehouse question",
          body: long,
          score: 1,
          scope: "workspace",
        },
        {
          id: "two",
          name: "entity_glossary",
          loadWhen: "Every metric definition",
          body: "short body",
          score: 1,
          scope: "workspace",
        },
      ],
    });
    expect(block).toContain("### Pinned skills (always loaded)");
    expect(block).toContain("`warehouse_map`");
    expect(block).toContain("Excerpt truncated");
    expect(block).toContain("`entity_glossary`");
    expect(block).toContain("short body");
    // Two bodies: one cut at the budget, one short — never the raw long body.
    expect(block).not.toContain(long);
    expect(block.length).toBeLessThan(MAX_SKILL_EXCERPT_CHARS + 600);
  });

  it("returns no block when nothing is pinned or a pinned body is empty", () => {
    expect(renderCompactSkillBlock({ injected: [] })).toBe("");
    expect(
      renderCompactSkillBlock({
        injected: [
          {
            id: "e",
            name: "empty",
            loadWhen: "x",
            body: "   ",
            score: 1,
            scope: "workspace",
          },
        ],
      }),
    ).toBe("");
  });
});
