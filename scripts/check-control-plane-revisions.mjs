// Read-only release verification. Keep full revision environments out of release logs.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const shortName = value => value?.split("/").pop();

export function checkControlPlaneRevisions(service, revisions) {
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
        v => v.name === "MAKO_CONTROL_PLANE_FENCE_V1" && v.value === "1",
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

async function main() {
  const { GCP_PROJECT_ID, GCP_REGION, SERVICE_NAME } = process.env;
  if (
    ![GCP_PROJECT_ID, GCP_REGION, SERVICE_NAME].every(
      v => v && /^[a-z0-9-]+$/.test(v),
    )
  )
    throw new Error("Missing Cloud Run target");
  const url =
    "https://run.googleapis.com/v2/projects/" +
    GCP_PROJECT_ID +
    "/locations/" +
    GCP_REGION +
    "/services/" +
    SERVICE_NAME;
  const token = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
  }).trim();
  const get = async url => {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok)
      throw new Error(
        "Cloud Run metadata unavailable (HTTP " + response.status + ")",
      );
    return response.json();
  };
  const service = await get(url);
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
            env: r.containers?.[0]?.env?.filter(
              v => v.name === "MAKO_CONTROL_PLANE_FENCE_V1",
            ),
          },
        ],
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  const evidence = checkControlPlaneRevisions(service, revisions);
  const final = await get(url);
  if (final.etag !== service.etag || !service.etag || final.reconciling)
    throw new Error("Cloud Run service changed during verification");
  console.info(
    JSON.stringify({ checkedAt: new Date().toISOString(), ...evidence }),
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
