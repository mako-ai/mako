// What a binding load is waiting on — the pure half (no React, no DuckDB),
// so `node --test` covers it without installing anything.
//
// From 2.7.4 the SDK asks every `__data` request for phase events
// (`Accept: application/x-ndjson`). A server that knows them answers one
// JSON object per line on the same connection and ends with exactly one
// `ready` or `failed`; a server that predates them answers as before
// (parquet bytes, a 302 to them, or JSON), and the SDK still knows when the
// download and the DuckDB load start. See api/src/apps/binding-progress.ts.

export const PROGRESS_ACCEPT = "application/x-ndjson, */*;q=0.5";

/**
 * Every phase, in the order a full rebuild passes through them. Server
 * phases come from the stream; `requesting`, `downloading`,
 * `loading_duckdb` and `running_sql` are the SDK's own.
 */
export const BINDING_PHASES = [
  "requesting",
  "queued",
  "checking",
  "querying_warehouse",
  "writing_parquet",
  "uploading",
  "resolving",
  "signing",
  "downloading",
  "loading_duckdb",
  "running_sql",
];

const STAGE_OF = {
  requesting: "waiting",
  queued: "building",
  checking: "waiting",
  querying_warehouse: "building",
  writing_parquet: "building",
  uploading: "building",
  resolving: "linking",
  signing: "linking",
  downloading: "downloading",
  loading_duckdb: "loading",
  running_sql: "querying",
};

/**
 * The wait a person cares about: `building` (the warehouse is running the
 * query — seconds to minutes), `linking` (Mako is finding and signing the
 * stored file — well under a second), `downloading`, `loading` (into
 * DuckDB), `querying` (your SQL), or `waiting` before the server says.
 */
export function bindingPhaseStage(phase) {
  return STAGE_OF[phase] ?? null;
}

export const BINDING_STAGE_LABELS = {
  waiting: "Contacting Mako",
  building: "Building from warehouse",
  linking: "Getting download link",
  downloading: "Downloading",
  loading: "Loading into DuckDB",
  querying: "Running query",
};

/** Finer wording per phase, for a tooltip or a second line. */
export const BINDING_PHASE_LABELS = {
  requesting: "Contacting Mako",
  queued: "Waiting for a build slot",
  checking: "Checking the binding",
  querying_warehouse: "Querying the warehouse",
  writing_parquet: "Writing parquet",
  uploading: "Storing the file",
  resolving: "Finding the file",
  signing: "Signing the download link",
  downloading: "Downloading",
  loading_duckdb: "Loading into DuckDB",
  running_sql: "Running query",
};

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * A caption for a progress bar: the stage label, plus rows or bytes when
 * known. Takes a phase name or a progress record (`useQuery().progress`).
 * Empty string when nothing is pending.
 */
export function bindingPhaseLabel(progress) {
  const p = typeof progress === "string" ? { phase: progress } : progress;
  const stage = p ? bindingPhaseStage(p.phase) : null;
  if (!stage) return "";
  const label = BINDING_STAGE_LABELS[stage];
  if (stage === "building" && typeof p.rowsWritten === "number") {
    return label + " · " + p.rowsWritten.toLocaleString("en-US") + " rows";
  }
  if (stage === "downloading" && typeof p.bytes === "number") {
    return (
      label +
      " · " +
      formatBytes(p.bytes) +
      (typeof p.bytesTotal === "number" ? " of " + formatBytes(p.bytesTotal) : "")
    );
  }
  return label;
}

// Most worth showing first when several bindings are pending at once: a
// warehouse build dwarfs everything, a download is the next longest.
const STAGE_WEIGHT = { building: 5, waiting: 4, downloading: 3, linking: 2, loading: 1, querying: 0 };

/**
 * One record for many pending bindings (useDuckDB): the phase of the one
 * furthest from done, rows summed over the builds, bytes over the
 * downloads, and how many are pending.
 */
export function combineBindingProgress(records) {
  const list = Object.values(records ?? {}).filter(Boolean);
  if (!list.length) return null;
  let top = list[0];
  for (const r of list) {
    const w = STAGE_WEIGHT[bindingPhaseStage(r.phase)] ?? -1;
    if (w > (STAGE_WEIGHT[bindingPhaseStage(top.phase)] ?? -1)) top = r;
  }
  const stage = bindingPhaseStage(top.phase);
  const same = list.filter(r => bindingPhaseStage(r.phase) === stage);
  const sum = key => {
    const known = same.filter(r => typeof r[key] === "number");
    return known.length ? known.reduce((n, r) => n + r[key], 0) : null;
  };
  return {
    phase: top.phase,
    rowsWritten: sum("rowsWritten"),
    bytes: sum("bytes"),
    bytesTotal: same.every(r => typeof r.bytesTotal === "number") ? sum("bytesTotal") : null,
    pending: list.length,
  };
}

/** Did the server answer with phase events? */
export function isProgressResponse(res) {
  const type = (res.headers && res.headers.get("content-type")) || "";
  return type.split(";")[0].trim().toLowerCase() === "application/x-ndjson";
}

/**
 * Read a phase stream: `onEvent` for every line, resolves with the terminal
 * event (`ready` or `failed`). A stream that ends without one resolves as
 * `failed` with status 502 — the connection broke before the server said.
 */
export async function readProgressStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const handle = line => {
    const text = line.trim();
    if (!text) return null;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return null;
    }
    if (event && (event.phase === "ready" || event.phase === "failed")) return event;
    if (event && event.phase) onEvent(event);
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const final = handle(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
      if (final) {
        reader.cancel().catch(() => {});
        return final;
      }
    }
    if (done) break;
  }
  return (
    handle(buffered) ?? {
      phase: "failed",
      status: 502,
      error: "The connection closed before the server finished",
    }
  );
}

/**
 * The response body as bytes, reporting `(received, total)` as it arrives.
 * `total` is null when the server sent no Content-Length.
 */
export async function readBytes(res, onProgress) {
  const total = Number(res.headers.get("content-length")) || null;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The Error a `failed` event becomes — the same shape as an HTTP failure. */
export function progressError(event, what) {
  const detail = [event.error, event.hint].filter(Boolean).join(" — ");
  const status = typeof event.status === "number" ? event.status : 502;
  const error = new Error(what + " (HTTP " + status + ")" + (detail ? ": " + detail : ""));
  error.status = status;
  if (typeof event.retryAfterMs === "number") error.retryAfterMs = event.retryAfterMs;
  return error;
}
