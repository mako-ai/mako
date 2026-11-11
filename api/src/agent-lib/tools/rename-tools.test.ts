/**
 * `rename_object` as an agent sees it: which kinds each surface offers, the
 * grant each kind takes, and what a call answers. The registry's own rules
 * are in rename/registry.test.ts and each kind's in its handler test; the
 * handlers here are stand-ins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renameKindAllowedOn, type AgentSurface } from "@mako/agent-tools";

const member = vi.hoisted(() => ({ role: "member" }));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: { getMember: vi.fn(async () => ({ role: member.role })) },
}));

import { RENAME_HANDLERS } from "../../rename/registry";
import {
  RENAME_KINDS,
  RenameError,
  type RenameHandler,
  type RenameKind,
} from "../../rename/types";
import { missingInputConditionalGrant } from "../capabilities/runtime";
import { createRenameTools } from "./rename-tools";

const WS = "66f000000000000000000001";
const SURFACES: AgentSurface[] = ["in-chat", "desktop-acp", "external-mcp"];

const original = { ...RENAME_HANDLERS };
afterEach(() => {
  for (const kind of RENAME_KINDS) delete RENAME_HANDLERS[kind];
  Object.assign(RENAME_HANDLERS, original);
  member.role = "member";
});

function stub(kind: RenameKind, rename = vi.fn()): typeof rename {
  RENAME_HANDLERS[kind] = {
    kind,
    describe: `what ${kind} renames`,
    resolve: async () => null,
    rename,
  } satisfies RenameHandler;
  return rename;
}

type RenameTool = {
  description: string;
  inputSchema: { shape: { kind: { options: string[] } } };
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const toolOn = (surface?: AgentSurface, userId: string | undefined = "u1") =>
  (
    createRenameTools(WS, userId, surface ? { surface } : {}) as unknown as {
      rename_object?: RenameTool;
    }
  ).rename_object;

describe("which kinds rename_object offers", () => {
  it("only kinds that have a handler, each with its own line", () => {
    for (const kind of RENAME_KINDS) delete RENAME_HANDLERS[kind];
    expect(toolOn("external-mcp")).toBeUndefined();
    stub("flow");
    stub("app");
    const tool = toolOn("external-mcp");
    expect(tool?.inputSchema.shape.kind.options).toEqual(["app", "flow"]);
    expect(tool?.description).toContain("- flow: what flow renames");
    expect(tool?.description).not.toContain("- skill:");
  });

  it("a connection over external MCP only, as update_connection", () => {
    for (const surface of SURFACES) {
      expect(renameKindAllowedOn("connection", surface)).toBe(
        surface === "external-mcp",
      );
      expect(renameKindAllowedOn("app", surface)).toBe(true);
    }
    expect(toolOn()?.inputSchema.shape.kind.options).toContain("connection");
    for (const surface of ["in-chat", "desktop-acp"] as const) {
      const kinds = toolOn(surface)?.inputSchema.shape.kind.options ?? [];
      expect(kinds).not.toContain("connection");
    }
    // With only a connection handler, those surfaces get no tool at all.
    for (const kind of RENAME_KINDS) delete RENAME_HANDLERS[kind];
    stub("connection");
    expect(toolOn("in-chat")).toBeUndefined();
    expect(toolOn("desktop-acp")).toBeUndefined();
    expect(toolOn("external-mcp")).toBeDefined();
  });

  it("a flow where the flow write tools are (external MCP); a dbt job everywhere", () => {
    for (const surface of SURFACES) {
      expect(renameKindAllowedOn("flow", surface)).toBe(
        surface === "external-mcp",
      );
      expect(renameKindAllowedOn("dbt_job", surface)).toBe(true);
      const kinds = toolOn(surface)?.inputSchema.shape.kind.options ?? [];
      expect(kinds.includes("flow")).toBe(surface === "external-mcp");
      expect(kinds).toContain("dbt_job");
    }
  });
});

describe("rename_object agent grants", () => {
  const none = new Set<never>();
  const missing = (kind: string) =>
    missingInputConditionalGrant("rename_object", { kind }, none);

  it("keeps each kind's own gate", () => {
    // flow_update and dbt_update_job: a key with only `mcp query:read` is
    // refused, with the grant named.
    for (const kind of ["flow", "dbt_job"]) {
      expect(missing(kind)).toMatchObject({
        grant: "warehouse-write",
        behavior: "renaming a flow or a dbt job",
      });
    }
    for (const kind of ["skill", "connector"]) {
      expect(missing(kind)).toMatchObject({ grant: "git-write" });
    }
    expect(missing("connection")).toMatchObject({
      grant: "connections-manage",
    });
  });

  it("everything else needs no grant beyond the tool itself", () => {
    for (const kind of ["app", "console", "notebook", "dbt_file"]) {
      expect(missing(kind)).toBeNull();
    }
  });

  it("a flow takes an owner or admin, as flow_update; a key with no person is not asked", async () => {
    const rename = stub("flow").mockResolvedValue({ kind: "flow", id: "f1" });
    const input = { kind: "flow", ref: "f1", title: "B" };
    expect(await toolOn("external-mcp")?.execute(input)).toEqual({
      success: false,
      error:
        "Renaming a flow requires at least the admin workspace role (you are a member).",
    });
    expect(rename).not.toHaveBeenCalled();
    member.role = "admin";
    expect(await toolOn("external-mcp")?.execute(input)).toMatchObject({
      success: true,
    });
    member.role = "member";
    const keyTool = (
      createRenameTools(WS, undefined, {
        surface: "external-mcp",
      }) as unknown as { rename_object: RenameTool }
    ).rename_object;
    expect(await keyTool.execute(input)).toMatchObject({ success: true });
  });

  it("a session holding the grant is not asked for it again", () => {
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "connection" },
        new Set(["connections-manage"] as const),
      ),
    ).toBeNull();
  });
});

describe("calling rename_object", () => {
  it("renames as the caller, with their live role, and returns the result", async () => {
    const rename = stub("app");
    rename.mockResolvedValue({
      kind: "app",
      id: "f1",
      before: { title: "A" },
      after: { title: "B" },
      aliasesAdded: [],
      warnings: [],
    });
    const result = await toolOn("in-chat")?.execute({
      kind: "app",
      ref: " f1 ",
      title: "B",
    });
    expect(rename).toHaveBeenCalledWith(
      { workspaceId: WS, userId: "u1", role: "member" },
      { ref: "f1", title: "B", slug: undefined, options: undefined },
    );
    expect(result).toMatchObject({
      success: true,
      id: "f1",
      after: { title: "B" },
    });
  });

  it("answers a refusal as an error the agent can read, never a throw", async () => {
    stub("app").mockRejectedValue(new RenameError("That name is taken", 409));
    expect(
      await toolOn("in-chat")?.execute({ kind: "app", ref: "f1", slug: "x" }),
    ).toEqual({ success: false, error: "That name is taken" });
  });
});
