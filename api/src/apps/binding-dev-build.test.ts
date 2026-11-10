/**
 * Dev builds — the laptop's uncommitted `bindings/<name>.sql`, built through
 * the API. What these pin:
 *
 *   - a writer's build reads no repo and no sandbox: the text's stored,
 *     content-addressed artifact answers, or the text is built as a draft;
 *   - a read-only caller gets only the artifact of the binding committed on
 *     main (the one repo read), never a build;
 *   - edited text, a binding only on the laptop, a refresh, or a dev dbt
 *     environment that changes the rendered SQL is a draft: built through
 *     the shared builder and NEVER stored as the app's artifact;
 *   - a dbt environment that renders like prod does not demote to a draft;
 *   - building anything needs write access; bad input is a 400, a failed
 *     query a 502.
 *
 * Pure: repo reads, rendering, the store and the builders are injected.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type {
  IAppProject,
  IDatabaseConnection,
} from "../database/workspace-schema";
import {
  bindingArtifactKey,
  bindingFromSource,
  type AppBinding,
} from "./bindings.service";
import { draftHash } from "./binding-draft-cache";
import {
  DevBuildError,
  devBuildAppBinding,
  planDevBuild,
  type DevBuildDeps,
  type DevBuildInput,
} from "./binding-dev-build";

const project = {
  _id: new Types.ObjectId(),
  workspaceId: new Types.ObjectId(),
} as unknown as IAppProject;
const CONN = new Types.ObjectId().toString();
const connection = { type: "bigquery" } as unknown as IDatabaseConnection;

const COMMITTED = `-- connection: ${CONN}\n-- dbt_project: p1\nselect * from {{ dbt_schema }}.leads`;
const committedBinding = bindingFromSource("leads", COMMITTED) as AppBinding;
const committedKey = bindingArtifactKey(committedBinding);

function deps(overrides: Partial<DevBuildDeps> = {}): DevBuildDeps {
  return {
    resolveDraft: vi.fn(async (_p, name, source) => {
      const binding = bindingFromSource(name, source);
      if (!binding) throw new Error(`Binding "${name}" has no connection`);
      return { binding, connection };
    }),
    committedBinding: vi.fn(async () => committedBinding),
    render: vi.fn(async (_p, binding, _connection, environment) => ({
      code: binding.code.replace(
        "{{ dbt_schema }}",
        environment ? `dbt_${environment.name}` : "dbt_prod",
      ),
    })),
    // Stored: the committed binding's build and any kept draft.
    artifactExists: vi.fn(
      async (key: string) =>
        key === committedKey || key.startsWith("apps/drafts/"),
    ),
    build: vi.fn(async () => ({
      filePath: "/tmp/draft.parquet",
      rowCount: 3,
      byteSize: 30,
    })),
    drafts: {
      lookup: vi.fn(async () => ({ kind: "miss" as const })),
      built: vi.fn(async () => "apps/drafts/p/h-1.parquet"),
      failed: vi.fn(async () => 60_000),
      forget: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

function input(overrides: Partial<DevBuildInput> = {}): DevBuildInput {
  return {
    project,
    name: "leads",
    actorId: "u1",
    userId: "u1",
    canWrite: true,
    source: COMMITTED,
    ...overrides,
  };
}

describe("devBuildAppBinding", () => {
  it("serves the committed artifact for unchanged text, even read-only", async () => {
    const d = deps();
    const result = await devBuildAppBinding(input({ canWrite: false }), d);
    expect(result).toEqual({
      kind: "artifact",
      artifactKey: committedKey,
      source: "committed",
    });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("serves a writer the stored artifact of unchanged text without reading the repo", async () => {
    // 2026-11-10: the committed binding was read through the caller's cloud
    // sandbox, stuck at a commit before the binding existed, and every
    // `vite dev` load of it answered HTTP 500. A writer's text is now the
    // whole input: its content-addressed key finds the stored build.
    const d = deps({
      committedBinding: vi.fn(async () => {
        throw new Error(
          "path '/home/user/app/bindings/leads.sql' does not exist",
        );
      }),
    });
    const result = await devBuildAppBinding(input(), d);
    expect(result).toEqual({
      kind: "artifact",
      artifactKey: committedKey,
      source: "committed",
    });
    expect(d.committedBinding).not.toHaveBeenCalled();
  });

  it("builds a binding that exists only on the laptop, without reading the repo", async () => {
    const d = deps({
      committedBinding: vi.fn(async () => {
        throw new Error("must not be read");
      }),
    });
    const source = `-- connection: ${CONN}\nselect * from brand_new`;
    const result = await devBuildAppBinding(
      input({ name: "brand_new", source }),
      d,
    );
    expect(result).toMatchObject({ kind: "draft", rowCount: 3 });
    expect(d.committedBinding).not.toHaveBeenCalled();
    expect(d.build).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ name: "brand_new", connectionId: CONN }),
      connection,
      "select * from brand_new",
    );
  });

  it("builds unchanged text as a draft when it has no stored artifact or on refresh", async () => {
    // Stored artifacts are built by publish, the schedule and materialize;
    // a laptop never writes one.
    const cases: Array<[DevBuildDeps, boolean]> = [
      [deps({ artifactExists: vi.fn(async () => false) }), false],
      [deps(), true],
    ];
    for (const [d, refresh] of cases) {
      const result = await devBuildAppBinding(input({ refresh }), d);
      expect(result).toMatchObject({ kind: "draft", rowCount: 3 });
      expect(d.build).toHaveBeenCalledTimes(1);
      expect(d.committedBinding).not.toHaveBeenCalled();
    }
  });

  it("builds edited SQL as a draft through the shared builder, never materializing it", async () => {
    const d = deps();
    const source = `${COMMITTED}\nwhere connected`;
    const result = await devBuildAppBinding(input({ source }), d);
    expect(result).toMatchObject({ kind: "draft", rowCount: 3 });
    expect(d.artifactExists).not.toHaveBeenCalledWith(committedKey);
    expect(d.build).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ name: "leads", connectionId: CONN }),
      connection,
      "select * from dbt_prod.leads\nwhere connected",
    );
  });

  it("renders {{ dbt_schema }} against the requested environment as a draft", async () => {
    const d = deps();
    const result = await devBuildAppBinding(
      input({ dbtEnvironment: "joan" }),
      d,
    );
    expect(result.kind).toBe("draft");
    // Defer to prod is the default with an environment.
    expect(d.render).toHaveBeenCalledWith(
      project,
      expect.anything(),
      connection,
      { name: "joan", userId: "u1", defer: true },
    );
    expect(d.build).toHaveBeenCalledWith(
      project,
      expect.anything(),
      connection,
      "select * from dbt_joan.leads",
    );
    // A personal schema is never answered with the app's stored artifact.
    expect(d.artifactExists).not.toHaveBeenCalledWith(committedKey);
  });

  it("passes dbtDefer: false through as an opt-out", async () => {
    const d = deps();
    await devBuildAppBinding(
      input({ dbtEnvironment: "joan", dbtDefer: false }),
      d,
    );
    expect(d.render).toHaveBeenCalledWith(
      project,
      expect.anything(),
      connection,
      { name: "joan", userId: "u1", defer: false },
    );
  });

  it("treats an environment that renders like prod as the committed binding", async () => {
    const d = deps();
    const result = await devBuildAppBinding(
      input({ dbtEnvironment: "prod" }),
      d,
    );
    expect(result).toEqual({
      kind: "artifact",
      artifactKey: committedKey,
      source: "committed",
    });
  });

  it("refuses a read-only caller when nothing is committed under that name", async () => {
    const d = deps({ committedBinding: vi.fn(async () => null) });
    await expect(
      devBuildAppBinding(input({ canWrite: false }), d),
    ).rejects.toMatchObject({ status: 403, message: /differs/ });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("treats a CRLF checkout of the committed file as the committed binding", async () => {
    const d = deps();
    const result = await devBuildAppBinding(
      input({
        canWrite: false,
        source: `${COMMITTED.replace(/\n/g, "\r\n")}\r\n`,
      }),
      d,
    );
    expect(result).toEqual({
      kind: "artifact",
      artifactKey: committedKey,
      source: "committed",
    });
  });

  it("a changed dbt_project alone is not the committed binding for a read-only caller", async () => {
    const d = deps();
    const source = COMMITTED.replace(
      "-- dbt_project: p1",
      "-- dbt_project: p2",
    );
    await expect(
      devBuildAppBinding(input({ source, canWrite: false }), d),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a committed LIVE binding copied locally as parquet is not served to a read-only caller", async () => {
    const d = deps({
      committedBinding: vi.fn(async () =>
        bindingFromSource(
          "leads",
          COMMITTED.replace(
            "-- dbt_project",
            "-- materialization: live\n-- dbt_project",
          ),
        ),
      ),
    });
    await expect(
      devBuildAppBinding(input({ canWrite: false }), d),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("builds a live binding as a draft (it has no artifact)", async () => {
    const d = deps();
    const source = COMMITTED.replace(
      "-- dbt_project",
      "-- materialization: live\n-- dbt_project",
    );
    const result = await devBuildAppBinding(input({ source }), d);
    expect(result.kind).toBe("draft");
  });

  it("refuses to build for a read-only caller", async () => {
    const d = deps();
    await expect(
      devBuildAppBinding(
        input({ canWrite: false, source: `${COMMITTED} limit 1` }),
        d,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      devBuildAppBinding(
        input({
          canWrite: false,
          refresh: true,
        }),
        d,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("rejects bad input before running anything", async () => {
    const d = deps({
      render: vi.fn(async () => {
        throw new Error('No dbt environment named "nope"');
      }),
    });
    await expect(
      devBuildAppBinding(input({ name: "../x" }), d),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      devBuildAppBinding(input({ source: "select 1" }), deps()),
    ).rejects.toMatchObject({ status: 400, message: /no connection/ });
    await expect(
      devBuildAppBinding(input({ dbtEnvironment: "nope" }), d),
    ).rejects.toMatchObject({ status: 400, message: /nope/ });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("keeps a draft build under its rendered-SQL hash", async () => {
    const d = deps();
    const source = `${COMMITTED}\nwhere connected`;
    const result = await devBuildAppBinding(input({ source }), d);
    // The kept key travels with the result (the async job serves it).
    expect(result).toMatchObject({
      kind: "draft",
      artifactKey: "apps/drafts/p/h-1.parquet",
    });
    expect(d.drafts.built).toHaveBeenCalledWith({
      projectId: project._id.toString(),
      name: "leads",
      hash: draftHash({
        connectionId: CONN,
        renderedCode: "select * from dbt_prod.leads\nwhere connected",
        devModifiedAt: null,
      }),
      filePath: "/tmp/draft.parquet",
      rowCount: 3,
      byteSize: 30,
    });
  });

  it("keys a dev-environment draft on when its dev relations were last written", async () => {
    const hashes: string[] = [];
    for (const devModifiedAt of [1759000000000, 1759000999000]) {
      const d = deps({
        render: vi.fn(async (_p, binding, _c, environment) => ({
          code: binding.code.replace(
            "{{ dbt_schema }}",
            environment ? "dbt_joan" : "dbt_prod",
          ),
          devModifiedAt: environment ? devModifiedAt : null,
        })),
      });
      await devBuildAppBinding(input({ dbtEnvironment: "joan" }), d);
      const call = vi.mocked(d.drafts.lookup).mock.calls[0];
      hashes.push(call[1]);
    }
    // A `dbt run` into the dev schema is a different draft: no stale reuse.
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("rebuilds when a kept draft's object is gone", async () => {
    const d = deps({
      artifactExists: vi.fn(async () => false),
      drafts: {
        lookup: vi.fn(async () => ({
          kind: "hit" as const,
          key: "apps/drafts/p/h-gone.parquet",
          rowCount: 3,
          builtAt: new Date(),
        })),
        built: vi.fn(async () => "apps/drafts/p/h-new.parquet"),
        failed: vi.fn(async () => 60_000),
        forget: vi.fn(async () => undefined),
      },
    });
    const result = await devBuildAppBinding(
      input({ source: `${COMMITTED}\nwhere connected` }),
      d,
    );
    expect(result.kind).toBe("draft");
    expect(d.drafts.forget).toHaveBeenCalledWith(
      project._id.toString(),
      "apps/drafts/p/h-gone.parquet",
    );
    expect(d.build).toHaveBeenCalledTimes(1);
  });

  it("serves a kept draft without re-running it; refresh rebuilds", async () => {
    const d = deps({
      drafts: {
        lookup: vi.fn(async () => ({
          kind: "hit" as const,
          key: "apps/drafts/p/h.parquet",
          rowCount: 3,
          builtAt: new Date(),
        })),
        built: vi.fn(async () => "apps/drafts/p/h-1.parquet"),
        failed: vi.fn(async () => 60_000),
        forget: vi.fn(async () => undefined),
      },
    });
    const source = `${COMMITTED}\nwhere connected`;
    expect(await devBuildAppBinding(input({ source }), d)).toEqual({
      kind: "artifact",
      artifactKey: "apps/drafts/p/h.parquet",
      source: "draft-cache",
    });
    expect(d.build).not.toHaveBeenCalled();

    const refreshed = await devBuildAppBinding(
      input({ source, refresh: true }),
      d,
    );
    expect(refreshed.kind).toBe("draft");
    expect(d.build).toHaveBeenCalledTimes(1);
  });

  it("a kept draft is never served to a read-only caller", async () => {
    const d = deps({
      drafts: {
        lookup: vi.fn(async () => ({
          kind: "hit" as const,
          key: "apps/drafts/p/h.parquet",
          rowCount: 3,
          builtAt: new Date(),
        })),
        built: vi.fn(async () => "apps/drafts/p/h-1.parquet"),
        failed: vi.fn(async () => 60_000),
        forget: vi.fn(async () => undefined),
      },
    });
    await expect(
      devBuildAppBinding(
        input({ canWrite: false, source: `${COMMITTED} limit 1` }),
        d,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(d.drafts.lookup).not.toHaveBeenCalled();
  });

  it("refuses a draft that is cooling down after failures, with a retry hint", async () => {
    const d = deps({
      drafts: {
        lookup: vi.fn(async () => ({
          kind: "cooling" as const,
          retryAfterMs: 90_000,
          failures: 2,
          error: "Unrecognized name: connected",
        })),
        built: vi.fn(async () => "apps/drafts/p/h-1.parquet"),
        failed: vi.fn(async () => 60_000),
        forget: vi.fn(async () => undefined),
      },
    });
    await expect(
      devBuildAppBinding(input({ source: `${COMMITTED} where connected` }), d),
    ).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 90_000,
      message: /failed 2 time\(s\).*Unrecognized name/,
    });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("planDevBuild decides without running the query (the async path)", async () => {
    const d = deps();
    const plan = await planDevBuild(
      input({ source: `${COMMITTED}\nwhere connected` }),
      d,
    );
    expect(plan.kind).toBe("build");
    expect(d.build).not.toHaveBeenCalled();
    if (plan.kind === "build") {
      expect((await plan.run()).kind).toBe("draft");
      expect(d.build).toHaveBeenCalledTimes(1);
    }
    // Refusals happen at planning time, before any job would be queued.
    await expect(
      planDevBuild(input({ canWrite: false, source: `${COMMITTED} x` }), d),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reports a failed query as a 502 with its message", async () => {
    const d = deps({
      build: vi.fn(async () => {
        throw new Error("Unrecognized name: connected");
      }),
    });
    const error = await devBuildAppBinding(
      input({ source: `${COMMITTED} where connected` }),
      d,
    ).catch(e => e);
    expect(error).toBeInstanceOf(DevBuildError);
    expect(error).toMatchObject({
      status: 502,
      message: "Unrecognized name: connected",
    });
    // Counted towards the backoff, and nothing kept.
    expect(d.drafts.failed).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "leads",
        error: "Unrecognized name: connected",
      }),
    );
    expect(d.drafts.built).not.toHaveBeenCalled();
  });
});
