/**
 * The runner: turns a connector module into a process speaking the wire.
 *
 * Invoked as `mako-connector <command> --connector ./connector.ts [...]`.
 * Every command writes JSON Lines to stdout and exits 0, or writes a TRACE
 * error and exits 1. Nothing else may reach stdout — see `guardStdout`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "./define.js";
import {
  emitCatalog,
  emitConnectionStatus,
  emitLog,
  emitRecord,
  emitSpec,
  emitState,
  emitTraceError,
} from "./protocol.js";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i++;
    }
  }
  return { command, options };
}

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * A connector that calls `console.log` would inject a line into the middle of
 * the protocol stream and corrupt the sync — a failure that looks like a
 * malformed record, not like a stray log. Console output goes to stderr
 * instead, where the flow log picks it up harmlessly.
 */
export function guardStdout() {
  const toStderr =
    (...args) => {
      process.stderr.write(`${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function loadConnector(connectorPath) {
  const absolute = path.resolve(connectorPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`No connector at ${absolute}`);
  }
  const module = await import(pathToFileURL(absolute).href);
  const connector = module.default;
  if (!connector?.__makoConnector) {
    throw new Error(
      `${connectorPath} must \`export default defineConnector({ ... })\` from @makoai/connector-sdk`,
    );
  }
  return connector;
}

/**
 * Which streams to read, and from what state.
 *
 * The catalog is Airbyte's ConfiguredAirbyteCatalog. Mako always sends one,
 * but a hand-run of the command without one should read everything rather
 * than nothing, because "no catalog" from a human means "show me the lot".
 */
function selectedStreams(catalog, connector) {
  if (!catalog?.streams?.length) return connector.entityNames();
  return catalog.streams
    .map(configured => configured.stream?.name)
    .filter(name => name && connector.entity(name));
}

function stateFor(state, stream) {
  if (!state) return {};
  const entries = Array.isArray(state) ? state : [state];
  for (const entry of entries) {
    const descriptor = entry?.stream?.stream_descriptor?.name ?? entry?.stream;
    if (descriptor === stream) return entry?.stream?.stream_state ?? entry?.stream_state ?? {};
  }
  return {};
}

export async function run(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const log = (level, message) => emitLog(level, message);

  const connector = await loadConnector(options.connector ?? "./connector.ts");
  const config = options.config ? readJson(options.config) : {};

  if (command === "spec") {
    emitSpec(connector.spec());
    return 0;
  }

  if (command === "check") {
    const ctx = createContext({ config, log });
    try {
      const result = await connector.check(ctx);
      emitConnectionStatus(result.status, result.message);
    } catch (error) {
      // A failed credential is not a crashed process: report FAILED with the
      // vendor's own message and exit 0, so the UI can show it as a form
      // error rather than "the connector is broken".
      emitConnectionStatus("FAILED", error instanceof Error ? error.message : String(error));
    }
    return 0;
  }

  if (command === "discover") {
    const ctx = createContext({ config, log });
    emitCatalog(await connector.discover(ctx));
    return 0;
  }

  if (command === "read") {
    const catalog = options.catalog ? readJson(options.catalog) : null;
    const state = options.state ? readJson(options.state) : null;
    // The chunk budget. Mako's engine drives a sync in bounded chunks and
    // resumes; without a limit a `read` would run to exhaustion and the
    // engine could never checkpoint. Airbyte sources have no such flag,
    // which is exactly why they need a different adapter.
    const maxIterations = Number(options["max-iterations"] ?? 0) || Infinity;

    for (const name of selectedStreams(catalog, connector)) {
      const entity = connector.entity(name);
      const ctx = createContext({ config, state: stateFor(state, name), log, entity: name });
      let iterations = 0;
      let latest = ctx.state;
      let exhausted = true;

      for await (const batch of entity.read(ctx, ctx.state)) {
        for (const record of batch.records ?? []) emitRecord(name, record);
        if (batch.state !== undefined) latest = batch.state;
        iterations++;
        if (iterations >= maxIterations) {
          // Stop mid-stream but leave the position exactly where the last
          // completed page ended: the next chunk resumes there, and no row
          // is read twice or skipped.
          exhausted = false;
          break;
        }
      }

      emitState(name, latest, { hasMore: !exhausted });
    }
    return 0;
  }

  throw new Error(`Unknown command "${command}". Expected spec, check, discover or read.`);
}

export async function main(argv) {
  guardStdout();
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    emitTraceError(
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error.stack : undefined,
    );
    process.exitCode = 1;
  }
}
