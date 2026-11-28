import { afterEach, expect, it, vi } from "vitest";

// The native handoff fixture exercises both real stores. These distinct reads
// catch release wiring that would route a production or preview request wrongly.
vi.mock("./cutover", () => ({
  createDbtCutoverRepo: () => ({ workspaceHasProject: () => true }),
}));
vi.mock("./pg.repo", () => ({
  PgDbtRepository: class {
    workspaceHasProject() {
      return false;
    }
  },
}));
vi.mock("./mongo.repo", () => ({ MongoDbtRepository: class {} }));

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["mako", undefined, true],
  ["mako-canary", undefined, true],
  [undefined, undefined, true],
  ["mako-pr-1571", undefined, false],
  ["mako-pr-1571", "1", true],
] as const)(
  "routes production service %s with fence marker %s",
  async (service, marker, fenced) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("K_SERVICE", service);
    vi.stubEnv("MAKO_DBT_FENCE_V1", marker);
    vi.resetModules();
    const { dbtRepo } = await import("./index");
    expect(await dbtRepo.workspaceHasProject("workspace")).toBe(fenced);
  },
);
