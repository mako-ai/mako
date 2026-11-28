import assert from "node:assert/strict";
import test from "node:test";
import { verifyControlPlaneWriters } from "./check-control-plane-revisions.mjs";

const env = {
  GCP_PROJECT_ID: "primary-project",
  GCP_MIGRATION_PROJECT_ID: "canary-project",
  GCP_REGION: "us-central1",
};

function fixture() {
  const base = "https://run.googleapis.com/v2/";
  const services = new Map();
  for (const [project, name] of [
    [env.GCP_PROJECT_ID, "mako"],
    [env.GCP_MIGRATION_PROJECT_ID, "mako-canary"],
  ]) {
    const resource = `projects/${project}/locations/${env.GCP_REGION}/services/${name}`;
    const current = name + "-00002-pre";
    services.set(base + resource, {
      name: resource,
      etag: "initial",
      generation: "2",
      observedGeneration: "2",
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
      latestReadyRevision: current,
      latestCreatedRevision: current,
      trafficStatuses: [{ revision: current, percent: 100 }],
      revisions: [
        {
          name: name + "-00001-lgj",
          conditions: [{ revisionReason: "RETIRED" }],
        },
        {
          name: current,
          containers: [
            { env: [{ name: "MAKO_CONTROL_PLANE_FENCE_V1", value: "1" }] },
          ],
        },
      ],
    });
  }
  const [main, canary] = services.values();
  const get = async request => {
    const url = new URL(request);
    const service = services.get(
      (url.origin + url.pathname).replace(/\/revisions$/, ""),
    );
    assert.ok(service, "unexpected target " + url.pathname);
    if (url.pathname.endsWith("/revisions")) {
      const index = Number(url.searchParams.get("pageToken"));
      return {
        revisions: [service.revisions[index]],
        nextPageToken:
          index + 1 < service.revisions.length ? String(index + 1) : undefined,
      };
    }
    return structuredClone(service);
  };
  return { main, canary, get };
}

test("both independent services serve prepared revisions and have retired their legacy writers", async () => {
  const { get } = fixture();
  const result = await verifyControlPlaneWriters(env, get);
  assert.deepEqual(
    result.services.map(s => s.retiredUnpreparedRevisions),
    [["mako-00001-lgj"], ["mako-canary-00001-lgj"]],
  );
});

test("a prepared main and a 100% live unprepared canary stop activation", async () => {
  const { canary, get } = fixture();
  const [old] = canary.revisions;
  canary.revisions = [old];
  old.conditions = [{ state: "CONDITION_SUCCEEDED" }];
  canary.latestReadyRevision = canary.latestCreatedRevision = old.name;
  canary.trafficStatuses = [{ revision: old.name, percent: 100 }];
  await assert.rejects(
    verifyControlPlaneWriters(env, get),
    /mako-canary.*lacks confirmed retirement: mako-canary-00001-lgj/,
  );
});

test("an unprepared canary at zero traffic still needs confirmed retirement", async () => {
  const { canary, get } = fixture();
  canary.revisions[0].conditions = [];
  await assert.rejects(
    verifyControlPlaneWriters(env, get),
    /lacks confirmed retirement: mako-canary-00001-lgj/,
  );
});

test("an unprepared tagged canary route still prevents activation", async () => {
  const { canary, get } = fixture();
  canary.trafficStatuses.push({
    revision: canary.revisions[0].name,
    tag: "old",
    percent: 0,
  });
  await assert.rejects(
    verifyControlPlaneWriters(env, get),
    /mako-canary.*tagged/,
  );
});

test("rechecks the primary service after reading the canary inventory", async () => {
  const { main, get } = fixture();
  await assert.rejects(
    verifyControlPlaneWriters(env, async url => {
      if (url.includes("mako-canary/revisions")) main.etag = "updated";
      return get(url);
    }),
    /services\/mako changed/,
  );
});

test("a missing canary target or unreadable revision page stops verification", async () => {
  const { get } = fixture();
  await assert.rejects(
    verifyControlPlaneWriters({ ...env, GCP_MIGRATION_PROJECT_ID: "" }, get),
    /project IDs/,
  );
  await assert.rejects(
    verifyControlPlaneWriters(env, async url => {
      if (url.includes("mako-canary/revisions") && url.endsWith("pageToken=1"))
        throw new Error("403");
      return get(url);
    }),
    /mako-canary: 403/,
  );
});

test("dbt and the six-collection handoff require their own marker on both services", async () => {
  const { main, canary, get } = fixture();
  const preparedEnv = service => service.revisions[1].containers[0].env;
  preparedEnv(main).push({ name: "MAKO_DBT_FENCE_V1", value: "1" });
  await assert.rejects(
    verifyControlPlaneWriters(env, get, { dbt: true }),
    /mako-canary.*lacks confirmed retirement/,
  );
  preparedEnv(canary)[0].name = "MAKO_DBT_FENCE_V1";
  assert.equal(
    (await verifyControlPlaneWriters(env, get, { dbt: true })).marker,
    "MAKO_DBT_FENCE_V1",
  );
  await assert.rejects(
    verifyControlPlaneWriters(env, get),
    /mako-canary.*lacks confirmed retirement/,
  );
});
