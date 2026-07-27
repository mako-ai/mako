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
