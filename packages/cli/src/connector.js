/**
 * `mako connector test <path>` — the conformance gate.
 *
 * A connector is only as good as the promise that it will still work when the
 * engine drives it, so this runs the same four commands the engine runs, in
 * the same order, and checks the things that silently break a sync rather than
 * failing loudly:
 *
 *   - the config form can actually be rendered, and secrets are declared
 *   - discover's declared types agree with what read actually emits
 *   - a bounded read stops at its budget and reports a resumable position
 *   - resuming from that position does not repeat or skip a row
 *
 * The last one is the reason this exists as a command rather than a checklist.
 * A connector whose state does not advance passes every other check and then
 * re-reads its first page forever in production.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const HELP = `mako connector test <path> [--config <file>] [--entity <name>]

  <path>            a connector folder (containing connector.yaml), or a connector file
  --config <file>   JSON credentials to run check, discover and read against
  --entity <name>   test only this entity (default: all of them)
  --json            machine-readable result

Without --config only the offline checks run: spec, its config schema, and the
connector's shape. That is what CI can do without a secret.`;

const ok = text => `  ok    ${text}`;
const bad = text => `  FAIL  ${text}`;
const skip = text => `  skip  ${text}`;

/** Locate the SDK runner, whether installed or in this repository. */
function findRunner() {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve("@makoai/connector-sdk/bin/mako-connector.js");
  } catch {
    const local = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../connector-sdk/bin/mako-connector.js",
    );
    if (fs.existsSync(local)) return local;
    throw new Error(
      "Cannot find @makoai/connector-sdk. Install it next to the connector: npm i @makoai/connector-sdk",
    );
  }
}

function runCommand(runner, connectorFile, command, options = {}) {
  const args = [runner, command, "--connector", connectorFile];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    args.push(`--${key}`, String(value));
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("close", code => {
      const messages = [];
      const malformed = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch {
          malformed.push(trimmed);
        }
      }
      resolve({ code, messages, malformed, stderr });
    });
  });
}

const first = (messages, type) => messages.find(m => m.type === type);

const traceError = messages => {
  const trace = messages.find(m => m.type === "TRACE" && m.trace?.type === "ERROR");
  return trace?.trace?.error?.message;
};

/** What a value looks like to JSON Schema, for comparing against `discover`. */
function observedType(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function declaredTypes(property) {
  const type = property?.type;
  const list = Array.isArray(type) ? type : type ? [type] : [];
  return list.filter(entry => entry !== "null");
}

export async function connector(ctx, positional, flags, io) {
  const sub = positional[0];
  if (sub !== "test") {
    io.log(HELP);
    return sub ? 2 : 0;
  }

  const target = positional[1] ?? ".";
  const resolved = path.resolve(target);
  const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  const connectorFile = isDir ? path.join(resolved, "connector.ts") : resolved;

  if (!fs.existsSync(connectorFile)) {
    io.log(`No connector at ${connectorFile}`);
    return 1;
  }
  if (isDir && !fs.existsSync(path.join(resolved, "connector.yaml"))) {
    io.log(
      `${resolved} has no connector.yaml. Mako will not discover this folder without one:\n\n  runtime: node\n`,
    );
    return 1;
  }

  const runner = findRunner();
  const configPath = flags.config ? path.resolve(String(flags.config)) : null;
  if (configPath && !fs.existsSync(configPath)) {
    io.log(`No config file at ${configPath}`);
    return 1;
  }

  const problems = [];
  const lines = [];
  const record = (passed, text) => {
    lines.push(passed ? ok(text) : bad(text));
    if (!passed) problems.push(text);
  };

  io.log(`Testing ${isDir ? resolved : connectorFile}\n`);

  // ---- spec ------------------------------------------------------------
  const specRun = await runCommand(runner, connectorFile, "spec");
  const spec = first(specRun.messages, "SPEC")?.spec;
  if (specRun.code !== 0 || !spec) {
    record(false, `spec: ${traceError(specRun.messages) ?? specRun.stderr.trim() ?? "no SPEC emitted"}`);
    io.log(lines.join("\n"));
    return 1;
  }
  record(true, `spec: ${spec.mako?.name ?? "?"} v${spec.mako?.version ?? "?"}`);
  record(specRun.malformed.length === 0, `spec: stdout carried only protocol messages`);

  const connectionSpecification = spec.connectionSpecification;
  const properties = connectionSpecification?.properties ?? {};
  record(
    Boolean(connectionSpecification),
    "spec: declares connectionSpecification, so a credential form can be rendered",
  );
  const secrets = Object.entries(properties).filter(
    ([, property]) => property?.airbyte_secret === true,
  );
  const secretLooking = Object.keys(properties).filter(name =>
    /key|token|secret|password|credential/i.test(name),
  );
  const unmarked = secretLooking.filter(name => properties[name]?.airbyte_secret !== true);
  record(
    unmarked.length === 0,
    unmarked.length === 0
      ? `spec: ${secrets.length} field(s) marked secret`
      : `spec: ${unmarked.join(", ")} look like secrets but are not marked \`airbyte_secret: true\`, so they would be stored unencrypted`,
  );

  if (!configPath) {
    lines.push(skip("check, discover and read need --config <file>"));
    io.log(lines.join("\n"));
    io.log(
      problems.length === 0
        ? "\nOffline checks passed. Pass --config to test against a real credential."
        : `\n${problems.length} problem(s).`,
    );
    return problems.length === 0 ? 0 : 1;
  }

  // ---- check -----------------------------------------------------------
  const checkRun = await runCommand(runner, connectorFile, "check", { config: configPath });
  const status = first(checkRun.messages, "CONNECTION_STATUS")?.connectionStatus;
  record(
    status?.status === "SUCCEEDED",
    status?.status === "SUCCEEDED"
      ? "check: connected"
      : `check: ${status?.message ?? traceError(checkRun.messages) ?? "no status emitted"}`,
  );
  if (status?.status !== "SUCCEEDED") {
    io.log(lines.join("\n"));
    io.log(`\n${problems.length} problem(s).`);
    return 1;
  }

  // ---- discover --------------------------------------------------------
  const discoverRun = await runCommand(runner, connectorFile, "discover", { config: configPath });
  const streams = first(discoverRun.messages, "CATALOG")?.catalog?.streams ?? [];
  record(streams.length > 0, `discover: ${streams.length} stream(s)`);

  const wanted = flags.entity ? streams.filter(s => s.name === String(flags.entity)) : streams;
  if (flags.entity && wanted.length === 0) {
    record(false, `discover: no stream named "${flags.entity}"`);
  }

  for (const stream of wanted) {
    if (!stream.source_defined_primary_key?.length) {
      lines.push(
        skip(
          `${stream.name}: no primary key declared, so the destination cannot merge updates (full refresh only)`,
        ),
      );
    }

    // ---- read, twice: a chunk, then its resumption --------------------
    const catalogPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mako-connector-test-")),
      "catalog.json",
    );
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ streams: [{ stream: { name: stream.name }, sync_mode: "full_refresh" }] }),
    );

    const firstChunk = await runCommand(runner, connectorFile, "read", {
      config: configPath,
      catalog: catalogPath,
      "max-iterations": 1,
    });
    const records = firstChunk.messages.filter(m => m.type === "RECORD");
    const state = firstChunk.messages.filter(m => m.type === "STATE").at(-1)?.state;

    record(
      firstChunk.code === 0,
      firstChunk.code === 0
        ? `${stream.name}: read one chunk (${records.length} record(s))`
        : `${stream.name}: read failed — ${traceError(firstChunk.messages) ?? firstChunk.stderr.trim()}`,
    );
    if (firstChunk.code !== 0) continue;

    record(
      Boolean(state),
      state
        ? `${stream.name}: emitted a resumable state`
        : `${stream.name}: emitted no STATE, so a sync could never resume or checkpoint`,
    );

    // Declared vs actual types. A mismatch here is what lands a timestamp in
    // a string column and makes a warehouse unable to partition by it.
    const declared = stream.json_schema?.properties ?? {};
    const sample = records[0]?.record?.data;
    if (sample && Object.keys(declared).length > 0) {
      const mismatches = [];
      for (const [field, value] of Object.entries(sample)) {
        const types = declaredTypes(declared[field]);
        if (types.length === 0) continue;
        const seen = observedType(value);
        if (seen && !types.includes(seen)) {
          mismatches.push(`${field} declared ${types.join("|")} but emitted ${seen}`);
        }
      }
      record(
        mismatches.length === 0,
        mismatches.length === 0
          ? `${stream.name}: emitted records match the declared schema`
          : `${stream.name}: ${mismatches.join("; ")}`,
      );

      const undeclared = Object.keys(sample).filter(field => !(field in declared));
      if (undeclared.length > 0) {
        lines.push(
          skip(
            `${stream.name}: ${undeclared.length} field(s) not in discover (${undeclared.slice(0, 5).join(", ")}) — they will land as strings`,
          ),
        );
      }
    }

    // Resumption. Only meaningful when the first chunk said there was more.
    if (state?.mako?.hasMore === true) {
      const statePath = path.join(path.dirname(catalogPath), "state.json");
      fs.writeFileSync(statePath, JSON.stringify(state));
      const secondChunk = await runCommand(runner, connectorFile, "read", {
        config: configPath,
        catalog: catalogPath,
        state: statePath,
        "max-iterations": 1,
      });
      const secondRecords = secondChunk.messages.filter(m => m.type === "RECORD");
      const firstIds = new Set(records.map(m => JSON.stringify(m.record.data)));
      const repeated = secondRecords.filter(m => firstIds.has(JSON.stringify(m.record.data)));
      record(
        repeated.length === 0 && secondRecords.length > 0,
        repeated.length > 0
          ? `${stream.name}: resuming re-read ${repeated.length} record(s) — the state does not advance, so a sync would loop`
          : secondRecords.length === 0
            ? `${stream.name}: resuming returned nothing although the first chunk said there was more`
            : `${stream.name}: resumes cleanly (${secondRecords.length} further record(s), none repeated)`,
      );
    } else {
      lines.push(skip(`${stream.name}: fits in one chunk, so resumption was not exercised`));
    }

    if (records.length > 0 && !flags.json) {
      const sampleKeys = Object.keys(records[0].record.data).slice(0, 6);
      lines.push(`        ${sampleKeys.join("  ")}`);
      for (const message of records.slice(0, 3)) {
        lines.push(
          `        ${sampleKeys.map(key => String(message.record.data[key] ?? "").slice(0, 18)).join("  ")}`,
        );
      }
    }
  }

  io.log(lines.join("\n"));
  if (flags.json) {
    io.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  } else {
    io.log(
      problems.length === 0
        ? "\nPassed. Push connectors/<slug>/ to main and Mako will index it."
        : `\n${problems.length} problem(s) to fix before this connector is usable.`,
    );
  }
  return problems.length === 0 ? 0 : 1;
}
