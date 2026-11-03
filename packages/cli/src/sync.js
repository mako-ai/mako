/**
 * `mako sync` — the workspace's syncs (flows) from the terminal: list them,
 * see how each entity is doing, start a backfill, change the triggers.
 *
 * It speaks MCP (`flow_list`, `flow_status`, `flow_backfill`, `flow_update`),
 * like `status` and `connection probe`, so the login token is enough and the
 * rules — what is shown, who may act, no secret in any answer — are the
 * server's, not this file's.
 */
import { callMcpTool } from "./status.js";

const HELP = `mako sync ls                                  every sync: triggers, engine, state
mako sync status <name|id>                    per entity: mode, backlog, failures, last materialised; last runs
mako sync backfill <name|id> [--entity a,b]   re-read every record now (owner/admin)
mako sync set <name|id> [--poll <cron|off>] [--webhook on|off] [--resync <cron|off>] [--tz <zone>]
                                              change what starts a sync (owner/admin)

  --json   the server's answer as JSON`;

function triggerText(t) {
  if (!t) return "";
  const parts = [];
  if (t.poll?.cron) parts.push(`poll ${t.poll.cron}`);
  if (t.webhook) parts.push("webhook");
  if (t.resync?.cron) parts.push(`resync ${t.resync.cron}`);
  return parts.length ? parts.join(" + ") : "no trigger";
}

function table(rows) {
  if (rows.length === 0) return ["  (none)"];
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map(r => String(r[i] ?? "").length)),
  );
  return rows.map(r =>
    `  ${r.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")}`.trimEnd(),
  );
}

function ago(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function done(out, flags, io, render) {
  if (flags.json) {
    io.log(JSON.stringify(out, null, 2));
    return out?.success === false ? 1 : 0;
  }
  if (!out || out.success === false) {
    io.log(out?.error ?? "no answer from the server");
    return 1;
  }
  io.log(render(out).join("\n"));
  return 0;
}

export async function sync(ctx, positional, flags, io = { log: console.log }) {
  const [sub, target] = positional;

  if (sub === "ls" || sub === "list") {
    const out = await callMcpTool(ctx, "flow_list", {});
    return done(out, flags, io, o =>
      table([
        ["NAME", "ID", "SOURCE", "TRIGGERS", "ENGINE", "STATE"],
        ...o.flows.map(f => [
          f.name,
          f.id,
          f.source?.connector ?? f.source?.kind ?? "",
          triggerText(f.triggers),
          f.engine ?? "",
          f.state ?? "",
        ]),
      ]),
    );
  }

  if (!target || !["status", "backfill", "set"].includes(sub)) {
    io.log(HELP);
    return sub && sub !== "help" ? 2 : 0;
  }

  if (sub === "status") {
    const out = await callMcpTool(ctx, "flow_status", { flow: target });
    return done(out, flags, io, o => [
      `${o.name} — ${triggerText(o.triggers)} — ${o.state ?? "?"}`,
      "",
      ...table([
        [
          "ENTITY",
          "MODE",
          "BACKLOG",
          "FAILURES",
          "MATERIALISED",
          "BACKFILL",
          "ROWS",
        ],
        ...o.entities.map(e => [
          e.entity,
          e.mode,
          e.backlog,
          e.consecutiveFailures,
          ago(e.lastMaterializedAt),
          ago(e.backfillCompletedAt),
          e.lifetimeRowsApplied,
        ]),
      ]),
      ...o.entities
        .filter(e => e.consecutiveFailures > 0 && e.lastFailureError)
        .map(e => `  ! ${e.entity}: ${e.lastFailureError}`),
      "",
      "Last runs:",
      ...table(
        o.executions.map(r => [
          r.startedAt,
          r.status,
          r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "",
          r.error ?? "",
        ]),
      ),
    ]);
  }

  if (sub === "backfill") {
    const args = { flow: target };
    if (flags.entity) {
      args.entities = String(flags.entity)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    }
    const out = await callMcpTool(ctx, "flow_backfill", args);
    return done(out, flags, io, o => [
      `Backfill ${o.resumed ? "resumed" : "started"} (run ${o.runId}). Follow it: mako sync status ${target}`,
    ]);
  }

  // set
  const args = { flow: target };
  if (flags.poll !== undefined) args.poll = String(flags.poll);
  if (flags.resync !== undefined) args.resync = String(flags.resync);
  if (flags.tz !== undefined) args.timezone = String(flags.tz);
  if (flags.webhook !== undefined) {
    const w = String(flags.webhook);
    if (w !== "on" && w !== "off") {
      io.log(`--webhook must be "on" or "off", got "${w}"`);
      return 2;
    }
    args.webhook = w;
  }
  if (
    args.poll === undefined &&
    args.resync === undefined &&
    args.webhook === undefined
  ) {
    io.log(HELP);
    return 2;
  }
  const out = await callMcpTool(ctx, "flow_update", args);
  return done(out, flags, io, o => [`Saved: ${triggerText(o.triggers)}`]);
}
