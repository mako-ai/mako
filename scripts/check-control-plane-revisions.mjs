// Read-only release verification. Keep full revision environments out of release logs.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const shortName = value => value?.split("/").pop();

const controlPlaneMarker = "MAKO_CONTROL_PLANE_FENCE_V1";
const dbtMarker = "MAKO_DBT_FENCE_V1";

export function checkControlPlaneRevisions(
  service,
  revisions,
  marker = controlPlaneMarker,
) {
  if (
    !service.generation ||
    service.generation !== service.observedGeneration ||
    service.reconciling ||
    service.terminalCondition?.state !== "CONDITION_SUCCEEDED"
  ) {
    throw new Error("Cloud Run service has not finished reconciling");
  }
  const prepared = new Set();
  const retired = [];
  for (const revision of revisions) {
    const name = shortName(revision.name);
    if (!name) throw new Error("Missing Cloud Run revision name");
    if (
      revision.containers?.[0]?.env?.some(
        v => v.name === marker && v.value === "1",
      )
    ) {
      prepared.add(name);
    } else if (
      !revision.conditions?.some(c => c.revisionReason === "RETIRED")
    ) {
      throw new Error(
        "Unprepared revision lacks confirmed retirement: " + name,
      );
    } else {
      retired.push(name);
    }
  }
  const routes = service.trafficStatuses ?? [];
  if (
    routes.reduce((n, r) => n + (r.percent ?? 0), 0) !== 100 ||
    !routes.every(r => prepared.has(shortName(r.revision))) ||
    !prepared.has(shortName(service.latestReadyRevision)) ||
    service.latestReadyRevision !== service.latestCreatedRevision
  ) {
    throw new Error(
      "All serving, tagged and latest revisions must be prepared",
    );
  }
  return {
    service: service.name,
    generation: service.generation,
    latestReadyRevision: shortName(service.latestReadyRevision),
    routes: routes.map(r => ({
      revision: shortName(r.revision),
      percent: r.percent ?? 0,
      tag: r.tag,
    })),
    preparedRevisions: [...prepared].sort(),
    retiredUnpreparedRevisions: retired.sort(),
  };
}

async function readRevisions(url, get, marker) {
  const revisions = [];
  let pageToken = "";
  do {
    const page = await get(
      url + "/revisions?" + new URLSearchParams({ pageSize: "100", pageToken }),
    );
    for (const r of page.revisions ?? []) {
      // Keep only the capability marker and retirement evidence across pages.
      revisions.push({
        name: r.name,
        conditions: r.conditions,
        containers: [
          {
            env: r.containers?.[0]?.env?.filter(v => v.name === marker),
          },
        ],
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return revisions;
}

export async function verifyControlPlaneWriters(
  env,
  get,
  { dbt = false } = {},
) {
  const marker = dbt ? dbtMarker : controlPlaneMarker;
  const { GCP_PROJECT_ID, GCP_MIGRATION_PROJECT_ID, GCP_REGION } = env;
  if (
    ![GCP_PROJECT_ID, GCP_MIGRATION_PROJECT_ID, GCP_REGION].every(
      value => value && /^[a-z0-9-]+$/.test(value),
    )
  ) {
    throw new Error(
      "Both production project IDs and the Cloud Run region are required",
    );
  }

  // Each service owns an independent endpoint and its own 100% traffic split.
  const services = [
    [GCP_PROJECT_ID, "mako"],
    [GCP_MIGRATION_PROJECT_ID, "mako-canary"],
  ].map(([project, service]) => {
    const resource = `projects/${project}/locations/${GCP_REGION}/services/${service}`;
    return { resource, url: "https://run.googleapis.com/v2/" + resource };
  });
  const snapshots = [];
  for (const { resource, url } of services) {
    const service = await get(url);
    snapshots.push({ resource, url, service });
  }

  const evidence = [];
  for (const { resource, url, service } of snapshots) {
    try {
      const revisions = await readRevisions(url, get, marker);
      evidence.push({
        ...checkControlPlaneRevisions(service, revisions, marker),
        resource,
      });
    } catch (error) {
      throw new Error(resource + ": " + error.message);
    }
  }
  // Bracket the entire cross-service inventory with both generation checks.
  for (const { resource, url, service } of snapshots) {
    const final = await get(url);
    if (!service.etag || final.etag !== service.etag || final.reconciling) {
      throw new Error(resource + " changed during writer verification");
    }
  }
  return { checkedAt: new Date().toISOString(), marker, services: evidence };
}

async function main() {
  const { values } = parseArgs({ options: { dbt: { type: "boolean" } } });
  const token = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
  const get = async url => {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok)
      throw new Error(
        url.split("?")[0] + " unavailable (HTTP " + response.status + ")",
      );
    return response.json();
  };
  console.info(
    JSON.stringify(await verifyControlPlaneWriters(process.env, get, values)),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
