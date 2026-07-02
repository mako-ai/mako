import { describe, expect, it } from "vitest";
import { DBT_ADMIN_ONLY, DBT_MEMBER_ONLY_GET, resolveDbtAccess } from "./rbac";

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
      // Merging a PR is the only write path into protected branches.
      { method: "POST", path: `${WS}/projects/abc/git/merge-pull-request` },
      // Editing/closing PRs is repo-level administration, not own-checkout
      // work — admin+ like merge.
      { method: "PATCH", path: `${WS}/projects/abc/git/pull-request/12` },
      { method: "POST", path: `${WS}/projects/abc/git/pull-request/12/close` },
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

  describe("member-allowed writes (files, ad-hoc, runs, sync, own-checkout git)", () => {
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
      // Per-user checkouts + drafts make these safe for members; protected
      // branches are enforced separately in the git service.
      { method: "POST", path: `${WS}/projects/abc/git/commit` },
      { method: "POST", path: `${WS}/projects/abc/git/commit-to-branch` },
      { method: "POST", path: `${WS}/projects/abc/git/branch` },
      { method: "POST", path: `${WS}/projects/abc/git/switch-branch` },
      { method: "POST", path: `${WS}/projects/abc/git/pull-request` },
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

  describe("member-only GitHub discovery GETs", () => {
    const githubGets = [
      `${WS}/github/repos`,
      `${WS}/github/branches`,
      `${WS}/github/repo-check`,
    ];

    it.each(githubGets)("blocks viewer + undetermined on GET %s", path => {
      expect(resolveDbtAccess({ method: "GET", path, role: "viewer" }).ok).toBe(
        false,
      );
      expect(
        resolveDbtAccess({ method: "GET", path, role: undefined }).ok,
      ).toBe(false);
      for (const role of ["member", "admin", "owner"]) {
        expect(resolveDbtAccess({ method: "GET", path, role }).ok).toBe(true);
      }
    });

    it("still allows viewers to GET ordinary reads", () => {
      expect(
        resolveDbtAccess({
          method: "GET",
          path: `${WS}/github/install-url`,
          role: "viewer",
        }).ok,
      ).toBe(true);
      expect(
        resolveDbtAccess({
          method: "GET",
          path: `${WS}/projects`,
          role: "viewer",
        }).ok,
      ).toBe(true);
    });
  });

  it("exposes non-empty policy tables", () => {
    expect(DBT_ADMIN_ONLY.length).toBeGreaterThan(0);
    expect(DBT_MEMBER_ONLY_GET.length).toBeGreaterThan(0);
  });
});
