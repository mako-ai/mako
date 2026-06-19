import { describe, expect, it } from "vitest";
import { DBT_ADMIN_ONLY, resolveDbtAccess } from "./rbac";

const WS = "/api/workspaces/64b000000000000000000001/dbt";

describe("resolveDbtAccess", () => {
  it("allows GET for every role, including viewer and unknown", () => {
    for (const role of ["owner", "admin", "member", "viewer", undefined]) {
      expect(
        resolveDbtAccess({ method: "GET", path: `${WS}/projects`, role }).ok,
      ).toBe(true);
    }
  });

  it("rejects writes when the role is undetermined", () => {
    const d = resolveDbtAccess({
      method: "POST",
      path: `${WS}/projects/abc/files/models%2Ffoo.sql`,
      role: undefined,
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
    expect(d.error).toMatch(/role not determined/i);
  });

  it("makes viewers read-only on every write verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const d = resolveDbtAccess({
        method,
        path: `${WS}/projects/abc/files/x`,
        role: "viewer",
      });
      expect(d.ok).toBe(false);
      expect(d.error).toMatch(/read-only/i);
    }
  });

  describe("admin-only deployment-config mutations", () => {
    const adminOnlyCases: Array<{ method: string; path: string }> = [
      { method: "POST", path: `${WS}/projects` },
      { method: "POST", path: `${WS}/projects/import-github` },
      { method: "PATCH", path: `${WS}/projects/64b000000000000000000abc` },
      { method: "DELETE", path: `${WS}/projects/64b000000000000000000abc` },
      { method: "POST", path: `${WS}/projects/abc/jobs` },
      { method: "PATCH", path: `${WS}/projects/abc/jobs/j1` },
      { method: "DELETE", path: `${WS}/projects/abc/jobs/j1` },
      { method: "POST", path: `${WS}/projects/abc/git/commit` },
      { method: "POST", path: `${WS}/projects/abc/git/branch` },
      { method: "POST", path: `${WS}/projects/abc/git/switch-branch` },
      { method: "POST", path: `${WS}/projects/abc/git/pull-request` },
    ];

    it.each(adminOnlyCases)(
      "blocks member on $method $path",
      ({ method, path }) => {
        expect(resolveDbtAccess({ method, path, role: "member" }).ok).toBe(
          false,
        );
        expect(resolveDbtAccess({ method, path, role: "admin" }).ok).toBe(true);
        expect(resolveDbtAccess({ method, path, role: "owner" }).ok).toBe(true);
      },
    );
  });

  describe("member-allowed writes (files, ad-hoc, runs, sync)", () => {
    const memberCases: Array<{ method: string; path: string }> = [
      { method: "PUT", path: `${WS}/projects/abc/files/models%2Ffoo.sql` },
      { method: "DELETE", path: `${WS}/projects/abc/files/models%2Ffoo.sql` },
      { method: "POST", path: `${WS}/projects/abc/files/rename` },
      { method: "POST", path: `${WS}/projects/abc/compile` },
      { method: "POST", path: `${WS}/projects/abc/run-select` },
      { method: "POST", path: `${WS}/projects/abc/command` },
      { method: "POST", path: `${WS}/projects/abc/jobs/j1/trigger` },
      { method: "POST", path: `${WS}/projects/abc/runs/r1/cancel` },
      { method: "POST", path: `${WS}/projects/abc/runs/r1/retry` },
      { method: "POST", path: `${WS}/projects/abc/sync` },
    ];

    it.each(memberCases)(
      "allows member on $method $path",
      ({ method, path }) => {
        expect(resolveDbtAccess({ method, path, role: "member" }).ok).toBe(
          true,
        );
      },
    );
  });

  it("does not let job-trigger match the admin-only job-create rule", () => {
    // /jobs$ (create, admin) vs /jobs/:id/trigger (member). Guard against the
    // looser regex accidentally catching trigger.
    expect(
      resolveDbtAccess({
        method: "POST",
        path: `${WS}/projects/abc/jobs/j1/trigger`,
        role: "member",
      }).ok,
    ).toBe(true);
  });

  it("exposes a non-empty admin-only policy table", () => {
    expect(DBT_ADMIN_ONLY.length).toBeGreaterThan(0);
  });
});
