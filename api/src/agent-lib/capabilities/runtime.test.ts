/**
 * The workspace-role floor is one registry rule enforced everywhere a tool
 * can execute — not a listing-only courtesy. A viewer asking chat to
 * "create a dbt project" must be refused by the same rule that 403s
 * POST /dbt/projects and that hides the tool from a viewer's MCP client.
 */
import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { CAPABILITY_GRANTS } from "@mako/agent-tools";

const ALL_CAPABILITY_GRANTS = new Set(CAPABILITY_GRANTS);

import {
  authorizeAgentCapability,
  enforceCapabilityGrantsAtExecution,
  missingWorkspaceRole,
} from "./runtime";

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
const run = (tools: ToolSet, name: string): Promise<unknown> =>
  (tools[name].execute as Exec)({}, {});

describe("workspace role floors", () => {
  it("reads the registry's minimumWorkspaceRole through one ladder", () => {
    expect(missingWorkspaceRole("dbt_create_project", "viewer")).toEqual({
      required: "admin",
    });
    expect(missingWorkspaceRole("dbt_create_project", "member")).toEqual({
      required: "admin",
    });
    expect(missingWorkspaceRole("dbt_create_project", "admin")).toBeNull();
    expect(missingWorkspaceRole("dbt_create_project", "owner")).toBeNull();
    expect(missingWorkspaceRole("create_dbt_file", "viewer")).toEqual({
      required: "member",
    });
    expect(missingWorkspaceRole("create_dbt_file", "member")).toBeNull();
    // No membership at all is never enough.
    expect(missingWorkspaceRole("create_dbt_file", null)).toEqual({
      required: "member",
    });
    expect(missingWorkspaceRole("create_dbt_file", undefined)).toEqual({
      required: "member",
    });
    // Tools without a floor are unaffected.
    expect(missingWorkspaceRole("read_dbt_file", "viewer")).toBeNull();
    expect(missingWorkspaceRole("not_a_capability", "viewer")).toBeNull();
  });

  it("authorizeAgentCapability denies below the floor when a role is supplied", () => {
    const base = {
      surface: "external-mcp" as const,
      queryAccess: "read" as const,
      grants: ALL_CAPABILITY_GRANTS,
    };
    expect(
      authorizeAgentCapability("dbt_create_job", {
        ...base,
        memberRole: "member",
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(
        /requires at least the admin workspace role/,
      ),
    });
    expect(
      authorizeAgentCapability("dbt_create_job", { ...base, memberRole: null }),
    ).toMatchObject({ allowed: false });
    expect(
      authorizeAgentCapability("dbt_create_job", {
        ...base,
        memberRole: "admin",
      }),
    ).toEqual({ allowed: true });
    // Surface-only listing decisions (no role given) do not hide the tool:
    // the in-product working set keeps the schema and enforces at execution.
    expect(authorizeAgentCapability("dbt_create_job", base)).toEqual({
      allowed: true,
    });
  });

  it("enforces the floor when the in-product tool EXECUTES, from the live role", async () => {
    let calls = 0;
    const tools = {
      dbt_create_project: {
        description: "x",
        execute: async () => {
          calls += 1;
          return { success: true };
        },
      },
      read_dbt_file: {
        description: "y",
        execute: async () => ({ success: true, contents: "" }),
      },
    } as unknown as ToolSet;

    let lookups = 0;
    const asViewer = enforceCapabilityGrantsAtExecution(
      tools,
      () => ALL_CAPABILITY_GRANTS,
      async () => {
        lookups += 1;
        return "viewer";
      },
    );
    const denied = await run(asViewer, "dbt_create_project");
    expect(denied).toMatchObject({
      success: false,
      error: expect.stringMatching(/admin workspace role \(you are a viewer\)/),
    });
    expect(calls).toBe(0);
    // Tools without a floor are not wrapped, so they never pay the lookup.
    await run(asViewer, "read_dbt_file");
    expect(lookups).toBe(1);

    const asAdmin = enforceCapabilityGrantsAtExecution(
      tools,
      () => ALL_CAPABILITY_GRANTS,
      async () => "admin",
    );
    await expect(run(asAdmin, "dbt_create_project")).resolves.toEqual({
      success: true,
    });
    expect(calls).toBe(1);
  });
});
