/**
 * The rendered .makorules block must reach BOTH prompt consumers: the
 * standalone dbt agent and the unified prompt (which is what production chat
 * actually resolves to). Regression guard against wiring only one of them.
 */
import { describe, expect, it, vi } from "vitest";

// Tool modules pulled in transitively by the dbt agent factory — inert here.
vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { buildCurrentScreenContext } from "../agents/unified/prompt";
import { dbtAgentFactory } from "../agents/dbt";
import type { AgentContext } from "../agents/types";
import { isDbtShapedTurn } from "./dbt-turn-shape";

const RULES_BLOCK = "### Project rules — `.makorules.md`\n\n- never select *";

function baseContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workspaceId: "507f1f77bcf86cd799439011",
    activeView: "console",
    userId: "u1",
    ...overrides,
  } as AgentContext;
}

describe("unified prompt", () => {
  it("includes the dbt rules block when present", () => {
    const prompt = buildCurrentScreenContext(
      baseContext({ dbtRulesBlock: RULES_BLOCK }),
    );
    expect(prompt).toContain("- never select *");
  });

  it("omits it when absent or blank", () => {
    expect(buildCurrentScreenContext(baseContext())).not.toContain(
      "Project rules",
    );
    expect(
      buildCurrentScreenContext(baseContext({ dbtRulesBlock: "   " })),
    ).not.toContain("Project rules");
  });
});

describe("isDbtShapedTurn", () => {
  // Regression guard: detectAgentId (api/src/agents/index.ts) always
  // resolves to "unified", so gating .makorules resolution on the resolved
  // agent id is a no-op that fires on every turn — including plain SQL
  // console / notebook turns with no dbt tab open, at real per-turn token
  // cost. The route must gate on turn shape instead.

  it("is true when a dbt tab is open, regardless of tabKind", () => {
    expect(
      isDbtShapedTurn({
        openTabs: [{ dbtProjectId: "proj1" }],
        tabKind: "console",
      }),
    ).toBe(true);
  });

  it("is true for a dbt-* tabKind even with no open tabs forwarded", () => {
    expect(isDbtShapedTurn({ openTabs: [], tabKind: "dbt-file" })).toBe(true);
    expect(isDbtShapedTurn({ tabKind: "dbt-file" })).toBe(true);
  });

  it("is false for a console-only turn", () => {
    expect(
      isDbtShapedTurn({
        openTabs: [{ dbtProjectId: undefined }],
        tabKind: "console",
      }),
    ).toBe(false);
  });

  it("is false with no tabs and no tabKind", () => {
    expect(isDbtShapedTurn({})).toBe(false);
    expect(isDbtShapedTurn({ openTabs: [], tabKind: undefined })).toBe(false);
  });
});

describe("dbt agent", () => {
  it("puts the rules block in the dynamic system message, not the cached one", () => {
    const config = dbtAgentFactory(baseContext({ dbtRulesBlock: RULES_BLOCK }));
    const [cached, dynamic] = config.systemPrompt as Array<{
      content: string;
      providerOptions?: unknown;
    }>;
    expect(dynamic.content).toContain("- never select *");
    // The base prompt carries the 1h cache breakpoint — per-project rules
    // must never land there or they poison the cached prefix.
    expect(cached.content).not.toContain("- never select *");
    expect(cached.providerOptions).toBeDefined();
  });

  it("omits the block when the project has no rules", () => {
    const config = dbtAgentFactory(baseContext());
    const dynamic = (config.systemPrompt as Array<{ content: string }>)[1];
    expect(dynamic.content).not.toContain("Project rules");
  });
});
