import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_EXCERPT_CHARS,
  renderCompactSkillBlock,
} from "../services/agent-turn-preparation.service";
import {
  MAX_PINNED_SKILL_BODY_CHARS,
  SKILL_INDEX_TURN_LIMIT,
  selectSkillIndexForTurn,
  type SkillIndexEntry,
} from "../services/skills.service";

describe("renderCompactSkillBlock", () => {
  it("renders the complete index plus pinned excerpts", () => {
    const long = "x".repeat(MAX_SKILL_EXCERPT_CHARS * 2);
    const block = renderCompactSkillBlock({
      index: [
        {
          id: "one",
          name: "warehouse_map",
          loadWhen: "Every warehouse question",
          scope: "workspace",
          pinned: true,
        },
        {
          id: "two",
          name: "entity_glossary",
          loadWhen: "Every metric definition",
          scope: "workspace",
          pinned: true,
        },
        {
          id: "three",
          name: "sales_playbook",
          loadWhen: "Sales analysis",
          scope: "workspace",
          pinned: false,
        },
      ],
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
    expect(block).toContain("#### Available skills (index)");
    expect(block).toContain("`sales_playbook`: Sales analysis");
    expect(block).toContain("#### Pinned skill excerpts (budgeted)");
    expect(block).toContain("`warehouse_map`");
    expect(block).toContain("Excerpt truncated");
    expect(block).toContain("`entity_glossary`");
    expect(block).toContain("short body");
    // Two bodies: one cut at the budget, one short — never the raw long body.
    expect(block).not.toContain(long);
  });

  it("bounds all pinned bodies together and leaves excess skills in the index", () => {
    const index = ["alpha", "bravo", "charlie", "delta"].map(name => ({
      id: name,
      name,
      loadWhen: `Use ${name}`,
      scope: "workspace" as const,
      pinned: true,
    }));
    const injected = index.map((skill, position) => ({
      ...skill,
      body: String(position).repeat(MAX_SKILL_EXCERPT_CHARS * 2),
      score: 1,
    }));
    const block = renderCompactSkillBlock({ index, injected });

    expect(block).toContain("`delta` (pinned): Use delta");
    expect(block).not.toContain("##### `delta`");
    expect(block).toContain("1 additional pinned skill was omitted");
    expect(block.length).toBeLessThan(MAX_PINNED_SKILL_BODY_CHARS + 2_000);
  });

  it("returns no block only when the complete index is empty", () => {
    expect(renderCompactSkillBlock({ index: [], injected: [] })).toBe("");
  });
});

describe("selectSkillIndexForTurn", () => {
  const index: SkillIndexEntry[] = [
    ...Array.from({ length: 134 }, (_, i) => ({
      id: `w${i}`,
      name: `workspace_skill_${i}`,
      loadWhen: `When the question is about topic ${i} of the business, its tables and its caveats.`,
      scope: "workspace" as const,
      pinned: i === 7,
    })),
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `s${i}`,
      name: `system_skill_${i}`,
      loadWhen: `System guidance number ${i}.`,
      scope: "system" as const,
      pinned: false,
    })),
  ];

  it("keeps pinned skills, then the ranked matches, up to the limit", () => {
    const selected = selectSkillIndexForTurn({ index, injected: [] }, [
      { name: "workspace_skill_120", scope: "workspace" },
      { name: "system_skill_3", scope: "system" },
    ]);
    const names = selected.index.map(s => s.name);
    expect(names).toHaveLength(SKILL_INDEX_TURN_LIMIT);
    expect(names).toContain("workspace_skill_7");
    expect(names).toContain("workspace_skill_120");
    expect(names).toContain("system_skill_3");
    expect(selected.omitted).toBe(index.length - SKILL_INDEX_TURN_LIMIT);
  });

  it("cuts the prompt block for a 134-skill workspace and says how to find the rest", () => {
    const full = renderCompactSkillBlock({ index, injected: [] });
    const turn = renderCompactSkillBlock(
      selectSkillIndexForTurn({ index, injected: [] }, []),
    );
    expect(turn).toContain("15 skills that best match this message");
    expect(turn).toContain("`search_skills`");
    expect(turn).toContain("`list_skills`");
    expect(full).toContain("This is the complete index.");
    expect(turn.length).toBeLessThan(full.length / 5);
  });

  it("leaves a small index whole", () => {
    const small = index.slice(0, 10);
    const selected = selectSkillIndexForTurn(
      { index: small, injected: [] },
      [],
    );
    expect(selected.index).toEqual(small);
    expect(selected.omitted).toBe(0);
  });
});
