/**
 * Dev builds — the laptop's uncommitted `bindings/<name>.sql`, built through
 * the API. What these pin:
 *
 *   - text identical to the committed binding reuses the committed artifact
 *     (read access suffices), or materializes it exactly as materialize does;
 *   - edited text, or a dev dbt environment that changes the rendered SQL, is
 *     a draft: built through the shared builder and NEVER stored/recorded;
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
import {
  DevBuildError,
  devBuildAppBinding,
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
const committedKey = bindingArtifactKey(
  bindingFromSource("leads", COMMITTED) as AppBinding,
);

function deps(overrides: Partial<DevBuildDeps> = {}): DevBuildDeps {
  return {
    resolveDraft: vi.fn(async (_p, name, source) => {
      const binding = bindingFromSource(name, source);
      if (!binding) throw new Error(`Binding "${name}" has no connection`);
      return { binding, connection };
    }),
    committedKey: vi.fn(async () => committedKey),
    render: vi.fn(async (_p, binding, environment) =>
      binding.code.replace(
        "{{ dbt_schema }}",
        environment ? `dbt_${environment.name}` : "dbt_prod",
      ),
    ),
    artifactExists: vi.fn(async () => true),
    materialize: vi.fn(async () => ({
      rowCount: 5,
      byteSize: 50,
      materializedAt: new Date("2026-09-28T10:00:00Z"),
      filePath: "/tmp/materialized.parquet",
    })),
    build: vi.fn(async () => ({
      filePath: "/tmp/draft.parquet",
      rowCount: 3,
      byteSize: 30,
    })),
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
    expect(result).toEqual({ kind: "artifact", artifactKey: committedKey });
    expect(d.build).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("materializes (stores) the committed binding when it has no artifact or on refresh", async () => {
    const cases: Array<[DevBuildDeps, boolean]> = [
      [deps({ artifactExists: vi.fn(async () => false) }), false],
      [deps(), true],
    ];
    for (const [d, refresh] of cases) {
      const result = await devBuildAppBinding(input({ refresh }), d);
      expect(result).toMatchObject({
        kind: "materialized",
        filePath: "/tmp/materialized.parquet",
        rowCount: 5,
      });
      expect(d.materialize).toHaveBeenCalledWith(project, "leads", "u1");
      expect(d.build).not.toHaveBeenCalled();
    }
  });

  it("builds edited SQL as a draft through the shared builder, never materializing it", async () => {
    const d = deps();
    const source = `${COMMITTED}\nwhere connected`;
    const result = await devBuildAppBinding(input({ source }), d);
    expect(result).toMatchObject({ kind: "draft", rowCount: 3 });
    expect(d.materialize).not.toHaveBeenCalled();
    expect(d.artifactExists).not.toHaveBeenCalled();
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
    expect(d.render).toHaveBeenCalledWith(project, expect.anything(), {
      name: "joan",
      userId: "u1",
    });
    expect(d.build).toHaveBeenCalledWith(
      project,
      expect.anything(),
      connection,
      "select * from dbt_joan.leads",
    );
    // A personal schema must never reach the app's stored artifact.
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("treats an environment that renders like prod as the committed binding", async () => {
    const d = deps();
    const result = await devBuildAppBinding(
      input({ dbtEnvironment: "prod" }),
      d,
    );
    expect(result).toEqual({ kind: "artifact", artifactKey: committedKey });
  });

  it("builds a draft when nothing is committed under that name", async () => {
    const d = deps({ committedKey: vi.fn(async () => null) });
    const result = await devBuildAppBinding(input(), d);
    expect(result.kind).toBe("draft");
    expect(d.materialize).not.toHaveBeenCalled();
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
    expect(d.materialize).not.toHaveBeenCalled();
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
  });
});
