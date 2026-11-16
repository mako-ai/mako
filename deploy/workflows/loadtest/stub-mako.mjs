// A stand-in for the Mako API, for the load test only.
//
//   POST /api/workflows/runtime/passes   a pass, given as Mako gives it: after
//                                        reading the run from Hatchet, with
//                                        the same 15 s memory per run
//   GET  /work?ms=<n>                    the I/O a step waits on
import { createServer } from "node:http";

const hatchetUrl = process.env.HATCHET_API_URL;
const token = process.env.HATCHET_CLIENT_TOKEN ?? "";
const ACTIVE_FOR_MS = 15_000;
const seen = new Map();
const stats = { passes: 0, refused: 0, hatchetReads: 0, hatchetErrors: 0 };

async function isExecuting(runId) {
  const at = seen.get(runId);
  if (at && Date.now() - at < ACTIVE_FOR_MS) return true;
  stats.hatchetReads++;
  try {
    const res = await fetch(
      `${hatchetUrl}/api/v1/stable/workflow-runs/${runId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(String(res.status));
    const detail = await res.json();
    const active = ["QUEUED", "RUNNING"].includes(detail.run?.status);
    if (active) seen.set(runId, Date.now());
    return active;
  } catch {
    stats.hatchetErrors++;
    return false;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://mako");
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/work") {
    setTimeout(
      () => json(200, { ok: true }),
      Number(url.searchParams.get("ms")) || 0,
    );
    return;
  }
  if (url.pathname === "/stats") return json(200, stats);
  if (url.pathname === "/api/workflows/runtime/passes") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { runId } = JSON.parse(raw || "{}");
    if (await isExecuting(runId)) {
      stats.passes++;
      return json(200, { pass: "mwp_loadtest" });
    }
    stats.refused++;
    return json(403, { error: `Run ${runId} is not an executing run` });
  }
  json(404, { error: "not found" });
}).listen(8080);
