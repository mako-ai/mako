/**
 * `mako connection probe <id|name>` — run a configured connection live.
 *
 * A CONNECTION is a credential Mako holds, configured with a CONNECTOR (the
 * code — see `mako connector test` for running that code from a folder on
 * this machine). This command runs a *source* connection against the real
 * platform: the credential check plus one bounded page of an entity, written
 * nowhere. It speaks MCP (`probe_connection`), like `status` and `publish`,
 * so the login token is enough and the rules — bounded, read-only, secrets
 * scrubbed — are the server's, not this file's.
 */
import { callMcpTool } from "./status.js";

const HELP = `mako connection probe <id|name> [--entity <name>] [--limit <n>] [--fields a,b] [--since <iso>]

Run a connection Mako has configured, with the credential Mako holds, live
against its platform. Nothing is written anywhere:

  <id|name>         the source connection, by id or by its name in Mako
  --entity <name>   read one page of this entity (omit: check the credential only)
  --limit <n>       records to show (default 20, max 200)
  --fields a,b      keep only these fields of each record
  --since <iso>     records changed since this instant, where the connector can
  --json            the full result as JSON

To run a connector's CODE from this checkout instead: mako connector test <path>.`;

const ok = text => `  ok    ${text}`;
const bad = text => `  FAIL  ${text}`;
const skip = text => `  skip  ${text}`;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** A source connection id from an id or a name, via list_connections. */
async function resolveConnectionId(ctx, target) {
  if (OBJECT_ID.test(target)) return { id: target };
  const out = await callMcpTool(ctx, "list_connections", { kind: "source" });
  if (out?.error) throw new Error(out.error);
  const connections = Array.isArray(out) ? out : (out?.connections ?? []);
  const wanted = target.toLowerCase();
  const matches = connections.filter(
    c => String(c.name).toLowerCase() === wanted,
  );
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} source connections are named "${target}"; pass the id instead: ${matches
        .map(c => c.id)
        .join(", ")}`,
    );
  }
  const known = connections
    .map(c => `  ${c.id}  ${c.name}  (${c.connector ?? c.type})`)
    .join("\n");
  throw new Error(
    `no source connection named "${target}" in this workspace.${known ? `\n\nConfigured source connections:\n${known}` : ""}`,
  );
}

function cell(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 24 ? `${text.slice(0, 21)}…` : text;
}

/** A small aligned table of the records' first columns. */
function renderRecords(records, fields) {
  if (records.length === 0) return ["  (no records)"];
  const columns =
    fields ??
    [
      ...new Set(
        records.flatMap(r =>
          r && typeof r === "object" ? Object.keys(r) : [],
        ),
      ),
    ].slice(0, 6);
  const rows = records.map(r => columns.map(c => cell(r?.[c])));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map(r => r[i].length)),
  );
  const line = cells =>
    `  ${cells.map((v, i) => v.padEnd(widths[i])).join("  ")}`;
  return [line(columns), ...rows.map(line)];
}

export async function connection(ctx, positional, flags, io) {
  const sub = positional[0];
  if (sub !== "probe") {
    io.log(HELP);
    return sub ? 2 : 0;
  }
  const target = positional[1];
  if (!target) {
    io.log(HELP);
    return 2;
  }

  const args = {};
  if (flags.entity) args.entity = String(flags.entity);
  if (flags.limit !== undefined) {
    const limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      io.log(`--limit must be a positive integer, got "${flags.limit}"`);
      return 2;
    }
    args.limit = limit;
  }
  if (flags.fields) {
    args.fields = String(flags.fields)
      .split(",")
      .map(f => f.trim())
      .filter(Boolean);
  }
  if (flags.since) {
    const since = new Date(String(flags.since));
    if (Number.isNaN(since.getTime())) {
      io.log(`--since must be an ISO 8601 instant, got "${flags.since}"`);
      return 2;
    }
    args.since = since.toISOString();
  }

  let resolved;
  try {
    resolved = await resolveConnectionId(ctx, target);
  } catch (error) {
    io.log(String(error.message ?? error));
    return 1;
  }

  const started = Date.now();
  const out = await callMcpTool(ctx, "probe_connection", {
    connectionId: resolved.id,
    ...args,
  });

  if (flags.json) {
    io.log(JSON.stringify(out, null, 2));
    return out?.error ? 1 : out?.check?.success === false ? 1 : 0;
  }

  if (out?.error) {
    io.log(`probe failed: ${out.error}`);
    return 1;
  }

  const label = `${out.connection?.name ?? resolved.name ?? resolved.id} (${out.connection?.connector ?? "?"})`;
  const lines = [];
  if (out.check?.success) {
    lines.push(ok(`check: connected — ${label}`));
  } else {
    lines.push(bad(`check: ${out.check?.message ?? "failed"} — ${label}`));
    io.log(lines.join("\n"));
    return 1;
  }

  const entity = out.entity;
  if (entity) {
    const more = entity.hasMore
      ? ", more pages on the platform"
      : ", no further pages";
    const cut = entity.truncated
      ? ` (page held ${entity.received}, showing ${entity.count})`
      : "";
    lines.push(ok(`${entity.name}: ${entity.count} record(s)${cut}${more}`));
    if (entity.schema && Object.keys(entity.schema).length > 0) {
      const declared = Object.entries(entity.schema)
        .slice(0, 12)
        .map(([name, type]) => `${name}:${type}`)
        .join("  ");
      lines.push(
        `        schema  ${declared}${Object.keys(entity.schema).length > 12 ? "  …" : ""}`,
      );
    }
    lines.push("");
    lines.push(...renderRecords(entity.records ?? [], args.fields));
    for (const log of entity.logs ?? []) {
      lines.push(`  ${log.level.padEnd(5)} ${log.message}`);
    }
  } else if (args.entity) {
    lines.push(skip(`${args.entity}: not read, because the check failed`));
  }

  lines.push("");
  lines.push(
    `Read live from the platform in ${((out.durationMs ?? Date.now() - started) / 1000).toFixed(1)}s; nothing was written.` +
      (entity
        ? ""
        : " Pass --entity <name> to read one page (inspect_connection lists the names)."),
  );
  io.log(lines.join("\n"));
  return 0;
}
