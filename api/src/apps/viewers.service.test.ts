/**
 * Viewer roles: the repo narrows what an admitted viewer sees, never widens
 * it, and a viewer nobody claims is refused rather than shown everything.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../logging", () => {
  const stub = () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return { loggers: new Proxy({}, { get: () => stub }) };
});
// The pure functions under test never touch the repo; keep git and mongo out.
vi.mock("./worktree.service", () => ({ readFile: vi.fn() }));

import {
  bindingVisibleTo,
  compileRowFilter,
  parseBindingPolicy,
  parseViewersConfig,
  resolveViewer,
  type ViewersConfig,
} from "./viewers.service";

function mustParse(manifest: unknown): ViewersConfig {
  const config = parseViewersConfig(manifest);
  if (!config) throw new Error("expected a viewers config");
  return config;
}

const manifest = {
  title: "FR Sales",
  viewers: {
    default: "bdr",
    roles: {
      team_lead: { members: { "Lead@RealAdvisor.com": {} } },
      bdr: { members: { "sam@realadvisor.com": { rep: "Sam Ple" } } },
    },
  },
};

describe("parseViewersConfig", () => {
  it("returns null for an app without a viewers block", () => {
    expect(parseViewersConfig({ title: "x" })).toBeNull();
    expect(parseViewersConfig(null)).toBeNull();
    expect(parseViewersConfig({ viewers: null })).toBeNull();
  });

  it("keeps declaration order and lowercases member emails", () => {
    const config = parseViewersConfig(manifest);
    expect(config?.defaultRole).toBe("bdr");
    expect(config?.roles.map(r => r.name)).toEqual(["team_lead", "bdr"]);
    expect(config?.roles[0].members.get("lead@realadvisor.com")).toEqual({});
    expect(config?.roles[1].members.get("sam@realadvisor.com")).toEqual({
      rep: "Sam Ple",
    });
  });

  it("rejects a malformed block instead of ignoring it", () => {
    expect(() => parseViewersConfig({ viewers: { roles: {} } })).toThrow(
      /at least one role/,
    );
    expect(() =>
      parseViewersConfig({ viewers: { default: "ghost", roles: { a: {} } } }),
    ).toThrow(/default role "ghost"/);
    expect(() =>
      parseViewersConfig({ viewers: { roles: { "Team Lead": {} } } }),
    ).toThrow(/role "Team Lead"/);
    expect(() =>
      parseViewersConfig({
        viewers: { roles: { a: { members: { "not-an-email": {} } } } },
      }),
    ).toThrow(/not an email/);
    expect(() =>
      parseViewersConfig({
        viewers: { roles: { a: { members: { "x@y.z": { email: "other" } } } } },
      }),
    ).toThrow(/built-in claim/);
    expect(() =>
      parseViewersConfig({ viewers: { roles: { a: {} }, extra: true } }),
    ).toThrow(/invalid/);
  });
});

describe("resolveViewer", () => {
  const config = mustParse(manifest);

  it("gives a listed member their role and claims, email case-insensitively", () => {
    expect(resolveViewer(config, { email: "LEAD@realadvisor.com" })).toEqual({
      email: "lead@realadvisor.com",
      role: "team_lead",
      claims: { email: "lead@realadvisor.com", role: "team_lead" },
    });
    expect(resolveViewer(config, { email: "sam@realadvisor.com" })).toEqual({
      email: "sam@realadvisor.com",
      role: "bdr",
      claims: { rep: "Sam Ple", email: "sam@realadvisor.com", role: "bdr" },
    });
  });

  it("falls back to the default role, and refuses when there is none", () => {
    expect(resolveViewer(config, { email: "new@realadvisor.com" })?.role).toBe(
      "bdr",
    );
    const strict = mustParse({
      viewers: { roles: { team_lead: { members: { "a@b.c": {} } } } },
    });
    expect(resolveViewer(strict, { email: "nobody@b.c" })).toBeNull();
  });

  it("first declared role wins when a member is listed twice", () => {
    const both = mustParse({
      viewers: {
        roles: {
          team_lead: { members: { "x@y.z": {} } },
          bdr: { members: { "x@y.z": {} } },
        },
      },
    });
    expect(resolveViewer(both, { email: "x@y.z" })?.role).toBe("team_lead");
  });
});

describe("binding policies", () => {
  it("reads roles and per-role row filters from front matter", () => {
    const policy = parseBindingPolicy({
      connection: "c",
      roles: "team_lead, BDR",
      row_filter_bdr: " sales_rep_email = {{ viewer.email }} ",
    });
    expect(policy.roles).toEqual(["team_lead", "bdr"]);
    expect(policy.rowFilters).toEqual({
      bdr: "sales_rep_email = {{ viewer.email }}",
    });
    expect(bindingVisibleTo(policy, "bdr")).toBe(true);
    expect(bindingVisibleTo(policy, "csm")).toBe(false);
    expect(bindingVisibleTo(parseBindingPolicy({}), "anyone")).toBe(true);
  });

  it("binds claims as parameters, never as text", () => {
    const viewer = {
      email: "o'hara@x.com",
      role: "bdr",
      claims: { email: "o'hara@x.com", role: "bdr", rep: "O'Hara" },
    };
    expect(
      compileRowFilter(
        "sales_rep_email = {{ viewer.email }} OR rep = {{viewer.rep}}",
        viewer,
      ),
    ).toEqual({
      sql: "sales_rep_email = $1 OR rep = $2",
      params: ["o'hara@x.com", "O'Hara"],
    });
  });

  it("compiles to FALSE when the viewer lacks a claim the filter needs", () => {
    const viewer = {
      email: "a@b.c",
      role: "bdr",
      claims: { email: "a@b.c", role: "bdr" },
    };
    expect(compileRowFilter("team = {{ viewer.team }}", viewer)).toEqual({
      sql: "FALSE",
      params: [],
    });
  });

  it("refuses anything that is not a single expression", () => {
    const viewer = {
      email: "a@b.c",
      role: "bdr",
      claims: { email: "a@b.c", role: "bdr" },
    };
    expect(() => compileRowFilter("", viewer)).toThrow(/empty/);
    expect(() => compileRowFilter("x = 1; DROP TABLE t", viewer)).toThrow(
      /single expression/,
    );
    expect(() => compileRowFilter("x = 1 -- c", viewer)).toThrow(
      /single expression/,
    );
    expect(() => compileRowFilter("x = 1 /* c */", viewer)).toThrow(
      /single expression/,
    );
  });
});

describe("a viewers source — roles resolved from a binding's rows", () => {
  const sourced = mustParse({
    viewers: {
      source: "fr_viewers",
      default: "team_lead",
      roles: { team_lead: {}, bdr: {} },
    },
  });

  it("parses the source binding name and keeps roles member-less", () => {
    expect(sourced.source).toBe("fr_viewers");
    expect(sourced.roles.map(r => r.members.size)).toEqual([0, 0]);
    expect(() =>
      parseViewersConfig({
        viewers: { source: "../x", roles: { a: {} } },
      }),
    ).toThrow(/source/);
  });

  it("a source row gives the viewer its role, its other columns as claims", () => {
    const row = { email: "Sam@RealAdvisor.com", role: "bdr", rep: "Sam Ple" };
    expect(
      resolveViewer(sourced, { email: "sam@realadvisor.com" }, row),
    ).toEqual({
      email: "sam@realadvisor.com",
      role: "bdr",
      claims: { rep: "Sam Ple", email: "sam@realadvisor.com", role: "bdr" },
    });
  });

  it("no row → the default; a row naming an undeclared role is refused", () => {
    expect(
      resolveViewer(sourced, { email: "lead@realadvisor.com" }, null)?.role,
    ).toBe("team_lead");
    expect(() =>
      resolveViewer(
        sourced,
        { email: "x@realadvisor.com" },
        { email: "x@realadvisor.com", role: "csm" },
      ),
    ).toThrow(/"csm"/);
  });

  it("a member listed in mako.json wins over the source row", () => {
    const pinned = mustParse({
      viewers: {
        source: "fr_viewers",
        roles: {
          team_lead: { members: { "sam@realadvisor.com": {} } },
          bdr: {},
        },
      },
    });
    expect(
      resolveViewer(
        pinned,
        { email: "sam@realadvisor.com" },
        { email: "sam@realadvisor.com", role: "bdr" },
      )?.role,
    ).toBe("team_lead");
  });
});
