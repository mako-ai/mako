/**
 * What an app binding build writes, and where.
 *
 * The artifact key is a hash of the binding's definition. Every published app
 * reads its data at that key, so a change to the hashed bytes orphans every
 * artifact in the bucket. The canon is joined with U+0000. The source spells
 * it `"\u0000"` (a literal NUL byte made GitHub render the file as binary);
 * the known hashes below pin the bytes.
 *
 * The codec is app-binding-only: app builds pass the configurable options
 * (default ZSTD), and the CDC/sync loaders never see them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.fn();
vi.mock("../services/parquet-build.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../services/parquet-build.service")
  >()),
  buildQueryParquetFile: (input: unknown) => build(input),
}));

import {
  bindingArtifactKey,
  bindingDefinitionHash,
  buildResolvedBindingParquet,
  type AppBinding,
} from "./bindings.service";
import { appBindingParquetWriteOptions } from "../utils/parquet-compression";

describe("binding artifact keys", () => {
  it("hash to the same keys as before the NUL literal became \\u0000", () => {
    const full = {
      connectionId: "65f0c0ffee0000000000abcd",
      databaseId: "analytics",
      databaseName: "warehouse",
      code: "  SELECT 1 AS n\n",
    };
    expect(bindingDefinitionHash(full)).toBe("579a4181670e9838");
    expect(bindingArtifactKey(full)).toBe(
      "apps/bindings/65f0c0ffee0000000000abcd/579a4181670e9838.parquet",
    );
    expect(
      bindingDefinitionHash({
        connectionId: "65f0c0ffee0000000000abcd",
        code: "SELECT * FROM t",
      }),
    ).toBe("841548e8fea93039");
  });
});

describe("app binding builds and the parquet codec", () => {
  const project = {
    _id: { toString: () => "6577f0f0f0f0f0f0f0f0f0f0" },
  } as any;
  const binding: AppBinding = {
    name: "campaign_daily",
    connectionId: "c1",
    materialization: "parquet",
    sql: "select 1 as x",
    code: "select 1 as x",
  };

  beforeEach(() => {
    build.mockReset();
    build.mockResolvedValue({ filePath: "/tmp/x.parquet", rowCount: 1 });
  });

  it("passes the app binding write options (ZSTD by default)", async () => {
    await buildResolvedBindingParquet(
      project,
      binding,
      { type: "bigquery" } as any,
      binding.code,
    );
    const input = build.mock.calls[0][0];
    expect(input.writeOptions).toBe(appBindingParquetWriteOptions());
    expect(input.writeOptions).toMatchObject({ codec: "ZSTD" });
  });
});
