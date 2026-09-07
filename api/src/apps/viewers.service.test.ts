/**
 * Viewer roles: who a viewer is comes from their workspace membership (job
 * role + country, set on the Members page); what a role may see comes from
 * binding front matter. A member with no job role sees nothing that is
 * scoped, and a binding never widens what the membership says.
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

import {
  bindingVisibleTo,
  compileRowFilter,
  isScopedPolicy,
  parseBindingPolicy,
  rowFilterFor,
  viewerFromMember,
} from "./viewers.service";

describe("viewerFromMember", () => {
  it("turns a membership into the viewer the app sees: email, role, country as claims", () => {
    expect(
      viewerFromMember({
        email: "Sam@RealAdvisor.com",
        jobRole: "bdr",
        country: "FR",
      }),
    ).toEqual({
      email: "sam@realadvisor.com",
      role: "bdr",
      claims: { email: "sam@realadvisor.com", role: "bdr", country: "FR" },
    });
  });

  it("a workspace owner or admin with no job role is an admin viewer", () => {
    expect(
      viewerFromMember({ email: "theo@realadvisor.com", accessRole: "owner" })
        .role,
    ).toBe("admin");
    expect(
      viewerFromMember({ email: "joan@realadvisor.com", accessRole: "admin" })
        .role,
    ).toBe("admin");
    // An explicit job role wins over the access role.
    expect(
      viewerFromMember({
        email: "x@realadvisor.com",
        accessRole: "admin",
        jobRole: "team_leader",
      }).role,
    ).toBe("team_leader");
    expect(
      viewerFromMember({ email: "m@realadvisor.com", accessRole: "member" })
        .role,
    ).toBeNull();
  });

  it("a member with no job role has no role and no country claim", () => {
    expect(viewerFromMember({ email: "new@realadvisor.com" })).toEqual({
      email: "new@realadvisor.com",
      role: null,
      claims: { email: "new@realadvisor.com" },
    });
  });
});

describe("binding policies", () => {
  const scoped = parseBindingPolicy({
    connection: "c",
    row_filter_bdr: "sales_rep_email = {{ viewer.email }}",
  });
  const restricted = parseBindingPolicy({
    connection: "c",
    roles: "team_leader, admin",
  });
  const open = parseBindingPolicy({ connection: "c" });

  it("reads roles and per-role row filters from front matter", () => {
    const policy = parseBindingPolicy({
      connection: "c",
      roles: "team_leader, BDR",
      row_filter_bdr: " sales_rep_email = {{ viewer.email }} ",
    });
    expect(policy.roles).toEqual(["team_leader", "bdr"]);
    expect(policy.rowFilters).toEqual({
      bdr: "sales_rep_email = {{ viewer.email }}",
    });
    expect(isScopedPolicy(policy)).toBe(true);
    expect(isScopedPolicy(open)).toBe(false);
  });

  it("a role reads a binding unless `roles` excludes it; a filter alone excludes nobody with a role", () => {
    expect(bindingVisibleTo(scoped, "bdr")).toBe(true);
    expect(bindingVisibleTo(scoped, "team_leader")).toBe(true);
    expect(bindingVisibleTo(restricted, "team_leader")).toBe(true);
    expect(bindingVisibleTo(restricted, "bdr")).toBe(false);
    expect(bindingVisibleTo(open, "anyone")).toBe(true);
  });

  it("admin sees everything: every binding, every row, whatever the front matter says", () => {
    const admin = {
      email: "theo@realadvisor.com",
      role: "admin",
      claims: { email: "theo@realadvisor.com", role: "admin" },
    };
    const adminFiltered = parseBindingPolicy({
      connection: "c",
      roles: "bdr",
      row_filter_admin: "1 = 0",
    });
    expect(bindingVisibleTo(restricted, "admin")).toBe(true);
    expect(bindingVisibleTo(adminFiltered, "admin")).toBe(true);
    expect(rowFilterFor(adminFiltered, admin)).toBeUndefined();
    const bdr = {
      email: "sam@x.com",
      role: "bdr",
      claims: { email: "sam@x.com", role: "bdr" },
    };
    expect(rowFilterFor(scoped, bdr)).toBe(
      "sales_rep_email = {{ viewer.email }}",
    );
    expect(
      rowFilterFor(scoped, { ...bdr, role: "team_leader" }),
    ).toBeUndefined();
  });

  it("no role (unassigned member, anonymous share) reads only unscoped bindings", () => {
    expect(bindingVisibleTo(open, null)).toBe(true);
    expect(bindingVisibleTo(scoped, null)).toBe(false);
    expect(bindingVisibleTo(restricted, null)).toBe(false);
  });

  it("binds claims as parameters, never as text", () => {
    const viewer = {
      email: "o'hara@x.com",
      role: "bdr",
      claims: { email: "o'hara@x.com", role: "bdr", country: "FR" },
    };
    expect(
      compileRowFilter(
        "sales_rep_email = {{ viewer.email }} OR country = {{viewer.country}}",
        viewer,
      ),
    ).toEqual({
      sql: "sales_rep_email = $1 OR country = $2",
      params: ["o'hara@x.com", "FR"],
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
  });
});
