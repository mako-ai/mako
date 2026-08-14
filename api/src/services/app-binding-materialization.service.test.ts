/**
 * App binding artifact-addressing tests, covering the per-dbt-environment
 * artifact plumbing: key/URL construction, environment-name safety, stale
 * build detection, and URL hydration.
 *
 * Run: tsx src/services/app-binding-materialization.service.test.ts
 */
import assert from "node:assert/strict";

import {
  assertSafeEnvironmentName,
  buildAppBindingArtifactKeyWithPrefix,
  buildAppBindingArtifactPath,
  hydrateAppBindingUrls,
  isEnvironmentBuildActive,
} from "./app-binding-artifact-paths";

const KEY_BASE = {
  prefix: "artifacts",
  workspaceId: "w1",
  appId: "a1",
  bindingId: "b1",
  definitionHash: "deadbeef",
};
const PATH_BASE = { workspaceId: "w1", appId: "a1", bindingId: "b1" };
const ARTIFACT_ROUTE =
  "/api/workspaces/w1/apps/a1/bindings/b1/materialization/artifact";

function main() {
  // Artifact keys: prod stays un-namespaced; environments get their own
  // prefix so a dev build can never overwrite the prod artifact.
  {
    const prod = buildAppBindingArtifactKeyWithPrefix(KEY_BASE);
    const dev = buildAppBindingArtifactKeyWithPrefix({
      ...KEY_BASE,
      environment: "dev",
    });
    assert.ok(prod.endsWith("/apps/a1/bindings/b1/deadbeef.parquet"));
    assert.ok(dev.endsWith("/apps/a1/bindings/b1/dev/deadbeef.parquet"));
    assert.notEqual(prod, dev);
  }

  // The serve route takes the environment as a QUERY param — an environment
  // path segment would 404.
  {
    const url = buildAppBindingArtifactPath({
      ...PATH_BASE,
      environment: "dev",
      revision: "123",
    });
    const [path, query] = url.split("?");
    assert.equal(path, ARTIFACT_ROUTE);
    const params = new URLSearchParams(query);
    assert.equal(params.get("env"), "dev");
    assert.equal(params.get("rev"), "123");

    // Prod, no revision: bare route, no query string at all.
    assert.equal(buildAppBindingArtifactPath(PATH_BASE), ARTIFACT_ROUTE);
  }

  // Environment names are interpolated into artifact keys AND
  // `cache.environments.<env>.<field>` Mongo update paths.
  {
    for (const name of ["dev", "prod", "staging", "dbt_alice", "pr-123"]) {
      assert.doesNotThrow(
        () => assertSafeEnvironmentName(name),
        `expected "${name}" to be accepted`,
      );
    }
    for (const name of ["../prod", "a.b", "$set", "", "with space", "a/b"]) {
      assert.throws(
        () => assertSafeEnvironmentName(name),
        `expected "${name}" to be rejected`,
      );
    }
  }

  // Stale detection is per environment: a fresh heartbeat means in flight, a
  // stopped one means the build is reclaimable.
  {
    assert.equal(
      isEnvironmentBuildActive({ status: "building", statusAt: new Date() }),
      true,
    );
    assert.equal(
      isEnvironmentBuildActive({
        status: "building",
        statusAt: new Date(Date.now() - 10 * 60 * 1000),
      }),
      false,
    );
    assert.equal(
      isEnvironmentBuildActive({ status: "ready", statusAt: new Date() }),
      false,
    );
    assert.equal(isEnvironmentBuildActive(undefined), false);
  }

  // Hydration fills a proxied URL for prod AND for each ready environment
  // artifact — without one, the browser has nothing to fetch.
  {
    const hydrated = hydrateAppBindingUrls({
      _id: "a1",
      workspaceId: "w1",
      dataBindings: [
        {
          id: "b1",
          cache: {
            parquetArtifactKey: "k",
            parquetBuildStatus: "ready",
            artifactRevision: "1",
            environments: {
              dev: {
                status: "ready",
                artifactKey: "k-dev",
                artifactRevision: "2",
              },
              staging: { status: "building" },
              broken: { status: "error", artifactKey: "stale" },
            },
          },
        },
      ],
    });
    const cache = hydrated.dataBindings![0].cache;
    assert.ok(cache.parquetUrl.includes("rev=1"));
    assert.ok(!cache.parquetUrl.includes("env="));
    assert.ok(cache.environments.dev.parquetUrl.includes("env=dev"));
    assert.ok(cache.environments.dev.parquetUrl.includes("rev=2"));
    // Not ready → nothing to serve.
    assert.equal(cache.environments.staging.parquetUrl, undefined);
    assert.equal(cache.environments.broken.parquetUrl, undefined);
  }

  // eslint-disable-next-line no-console
  console.log("app-binding-materialization tests passed");
}

main();
