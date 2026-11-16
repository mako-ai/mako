/**
 * `mako connector test <path>` — the conformance gate.
 *
 * A CONNECTOR is code: the folder under `connectors/<slug>/` that knows how
 * to check a credential and read entities. This command runs that code from
 * this machine, with a credential in a local file, against its own contract.
 * To run a connection Mako has CONFIGURED with a connector — the credential
 * Mako holds, live against the platform — see `mako connection probe`.
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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { callMcpTool } from "./status.js";
import { findRepoRoot } from "./context.js";

const HELP = `mako connector test <path> [--config <file>] [--entity <name>] [--remote]
mako connector eject <slug> [--version <x.y.z>] [--force]

  <path>            a connector folder (containing connector.yaml), or a connector file
  --config <file>   JSON credentials to run check, discover and read against
  --entity <name>   test only this entity (default: all of them)
  --remote          also ask Mako for ws:<slug>'s status and last build
  --json            machine-readable result

Without --config only the offline checks run: spec, its config schema, the
connector's shape and its dependency files. That is what CI can do without a
secret.

Dependencies: commit package.json with package-lock.json in the folder, never
node_modules/. Mako builds one bundle per source hash on push.

To run a connection Mako has configured, live against its platform:
  mako connection probe <id|name> [--entity <name>]

eject: connectors/<slug>/connector.yaml installs a Mako connector by
reference (source: mako/<slug>@<range>). Eject copies the source of the
version Mako resolved for it into that folder and drops source:. The folder
is then this workspace's own code: it no longer upgrades, and its connection
type stays ws:<slug>. --version picks another published version; --force
overwrites files already in the folder.`;

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
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // A spawn that never starts (ENOENT on the runner, EACCES, EAGAIN) emits
    // `error` and no `close`. Without this the promise never settles and the
    // command hangs forever with nothing on screen.
    child.on("error", error => {
      if (settled) return;
      settled = true;
      resolve({
        code: 1,
        messages: [],
        malformed: [],
        stderr: String(error.message ?? error),
      });
    });
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("close", code => {
      if (settled) return;
      settled = true;
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

/**
 * `entry:` out of connector.yaml, without a YAML parser.
 *
 * The CLI has no dependencies on purpose — it is spawned by npx on machines
 * Mako knows nothing about — and connector.yaml is a flat mapping of three
 * possible keys. A scan for the one key that decides which file runs is
 * enough, and it fails safe: anything it cannot read means connector.ts, the
 * same default the server applies.
 */
function entryFromManifest(manifestPath) {
  const DEFAULT_ENTRY = "connector.ts";
  try {
    for (const line of fs.readFileSync(manifestPath, "utf8").split("\n")) {
      const match = /^entry:\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(
        line.trim(),
      );
      if (match) return match[1];
    }
  } catch {
    // An unreadable manifest is reported by the caller, not here.
  }
  return DEFAULT_ENTRY;
}

const first = (messages, type) => messages.find(m => m.type === type);

const traceError = messages => {
  const trace = messages.find(
    m => m.type === "TRACE" && m.trace?.type === "ERROR",
  );
  return trace?.trace?.error?.message;
};

/** What a value looks like to JSON Schema, for comparing against `discover`. */
function observedType(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function declaredTypes(property) {
  const type = property?.type;
  const list = Array.isArray(type) ? type : type ? [type] : [];
  return list.filter(entry => entry !== "null");
}

const LOCKFILE = "package-lock.json";
const OTHER_LOCKFILES = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
];

/** Is anything under `node_modules/` in this folder tracked by git? */
function nodeModulesTracked(dir) {
  const result = spawnSync("git", ["ls-files", "--", "node_modules"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) return null; // not a git checkout: cannot tell
  return result.stdout.trim().length > 0;
}

/**
 * The dependency rules the push reconciler applies, as [passed, text] pairs
 * (`passed` null for an informational line).
 */
export function dependencyChecks(dir) {
  const checks = [];
  const has = name => fs.existsSync(path.join(dir, name));
  const slug = path.basename(dir);

  if (has("node_modules")) {
    const tracked = nodeModulesTracked(dir);
    if (tracked) {
      checks.push([
        false,
        `dependencies: node_modules/ is committed, and Mako refuses the folder. Run git rm -r --cached connectors/${slug}/node_modules and add node_modules/ to .gitignore`,
      ]);
    } else if (tracked === null) {
      checks.push([
        null,
        "dependencies: node_modules/ is here; make sure it is gitignored, because Mako refuses a folder that commits it",
      ]);
    }
  }

  if (!has("package.json")) {
    const stray = [LOCKFILE, ...OTHER_LOCKFILES].find(has);
    if (stray) {
      checks.push([false, `dependencies: ${stray} without package.json`]);
    }
    return checks;
  }

  const other = OTHER_LOCKFILES.find(has);
  if (!has(LOCKFILE)) {
    checks.push([
      false,
      other
        ? `dependencies: Mako installs with npm and needs ${LOCKFILE}, not ${other}. Run npm install here and commit ${LOCKFILE}`
        : `dependencies: package.json needs ${LOCKFILE} next to it. Run npm install here and commit it`,
    ]);
    return checks;
  }

  let count = 0;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    count = Object.keys(manifest.dependencies ?? {}).length;
  } catch (error) {
    checks.push([
      false,
      `dependencies: package.json is not valid JSON: ${error.message}`,
    ]);
    return checks;
  }
  checks.push([
    true,
    `dependencies: package.json + ${LOCKFILE} (${count} dependenc${count === 1 ? "y" : "ies"}); Mako bundles them into one file on push`,
  ]);
  if (count > 0 && !has("node_modules")) {
    checks.push([
      null,
      "dependencies: not installed here; run npm install in this folder before testing locally",
    ]);
  }
  return checks;
}

/**
 * The connector folder a file belongs to: the nearest ancestor holding
 * connector.yaml (an entry may sit in src/), else the file's own directory.
 */
function connectorFolderOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, "connector.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(file);
    dir = parent;
  }
}

/** `inspect_connector` for ws:<slug>: the indexed status and the last build. */
async function remoteStatus(ctx, dir) {
  const slug = path.basename(dir);
  let out;
  try {
    out = await callMcpTool(ctx, "inspect_connector", {
      connector: `ws:${slug}`,
    });
  } catch (error) {
    return [
      null,
      `mako: could not ask Mako about ws:${slug}: ${error.message}`,
    ];
  }
  if (out?.error) return [null, `mako: ${out.error}`];
  const build = out?.build;
  const buildText = build
    ? `, build ${build.status} (${String(build.hash ?? "").slice(0, 12)})${build.error ? `: ${build.error}` : ""}`
    : "";
  const blocked = out?.status === "blocked" || build?.status === "failed";
  return [
    !blocked,
    `mako: ws:${slug} is ${out?.status ?? "unknown"}${out?.blockedReason && !build?.error ? `: ${out.blockedReason}` : ""}${buildText}`,
  ];
}

/** `source:` out of connector.yaml, scanned like `entry:` above. */
export function sourceFromManifest(text) {
  for (const line of text.split("\n")) {
    const match = /^source:\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(
      line.trim(),
    );
    if (match) return match[1];
  }
  return null;
}

/**
 * `mako connector eject <slug>`: the source of the pinned registry version
 * into `connectors/<slug>/`, and `source:` gone.
 *
 * The pinned version is the one Mako resolved for this folder on its last
 * push (`inspect_connector ws:<slug>` -> `registry.version`), so the ejected
 * code is exactly the code that has been running. The source comes from the
 * registry (`inspect_connector mako/<slug>` with `includeSource`, as `release`), never from
 * npm or GitHub.
 */
export async function eject(ctx, positional, flags, io) {
  const slug = positional[1];
  if (!slug || !/^[a-z][a-z0-9-]*$/.test(slug)) {
    io.log(
      "Usage: mako connector eject <slug>   (the folder name under connectors/)",
    );
    return 2;
  }
  const root = ctx.repoRoot ?? findRepoRoot();
  if (!root) {
    io.log("Run this inside the workspace repository.");
    return 1;
  }
  const folder = path.join(root, "connectors", slug);
  const manifest = path.join(folder, "connector.yaml");
  if (!fs.existsSync(manifest)) {
    io.log(`No connectors/${slug}/connector.yaml here.`);
    return 1;
  }
  const reference = sourceFromManifest(fs.readFileSync(manifest, "utf8"));
  if (!reference) {
    io.log(
      `connectors/${slug}/connector.yaml has no source:, so it already holds its own code. Nothing to eject.`,
    );
    return 1;
  }
  const match = /^mako\/([a-z][a-z0-9-]*)@(.+)$/.exec(reference);
  if (!match) {
    io.log(`source: ${reference} is not a mako/<slug>@<range> reference.`);
    return 1;
  }
  const registrySlug = match[1];

  let version = typeof flags.version === "string" ? flags.version : null;
  if (!version) {
    let installed;
    try {
      installed = await callMcpTool(ctx, "inspect_connector", {
        connector: `ws:${slug}`,
      });
    } catch (error) {
      io.log(
        `Could not ask Mako which version ws:${slug} runs: ${error.message}`,
      );
      return 1;
    }
    version = installed?.registry?.version ?? null;
    if (!version) {
      io.log(
        `Mako has not resolved ${reference} for ws:${slug}${installed?.error ? ` (${installed.error})` : ""}. ` +
          "Push the folder first, or pass --version <x.y.z>.",
      );
      return 1;
    }
  }

  let published;
  try {
    published = await callMcpTool(ctx, "inspect_connector", {
      connector: `mako/${registrySlug}`,
      version,
      includeSource: true,
    });
  } catch (error) {
    io.log(`Could not fetch mako/${registrySlug}@${version}: ${error.message}`);
    return 1;
  }
  const files = published?.release?.files;
  if (!files || typeof files !== "object") {
    io.log(
      `Mako returned no source for mako/${registrySlug}@${version}${published?.error ? `: ${published.error}` : "."}`,
    );
    return 1;
  }

  const names = Object.keys(files).sort();
  for (const name of names) {
    const target = path.resolve(folder, name);
    if (!target.startsWith(`${folder}${path.sep}`)) {
      io.log(`Refusing ${name}: it escapes connectors/${slug}/.`);
      return 1;
    }
  }
  const yaml = files["connector.yaml"];
  if (typeof yaml !== "string" || sourceFromManifest(yaml)) {
    io.log(
      `mako/${registrySlug}@${version} has no runnable connector.yaml; refusing to eject it.`,
    );
    return 1;
  }
  const clashes = names.filter(
    name => name !== "connector.yaml" && fs.existsSync(path.join(folder, name)),
  );
  if (clashes.length > 0 && !flags.force) {
    io.log(
      `connectors/${slug}/ already holds ${clashes.join(", ")}. Move them away, or pass --force to overwrite.`,
    );
    return 1;
  }

  for (const name of names) {
    const target = path.join(folder, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[name]);
  }
  io.log(
    [
      `Ejected mako/${registrySlug}@${version} into connectors/${slug}/ (${names.length} files).`,
      `connector.yaml now runs ${published.release.entry ?? "connector.ts"} and has no source:.`,
      `The folder is this workspace's code: it no longer upgrades. Its connections keep the type ws:${slug}.`,
      `Next: npm install in connectors/${slug}/ to test it locally (mako connector test connectors/${slug}), then commit and push.`,
    ].join("\n"),
  );
  return 0;
}

export async function connector(ctx, positional, flags, io) {
  const sub = positional[0];
  if (sub === "eject") return eject(ctx, positional, flags, io);
  if (sub !== "test") {
    io.log(HELP);
    return sub ? 2 : 0;
  }

  const target = positional[1] ?? ".";
  const resolved = path.resolve(target);
  const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  const manifest = path.join(resolved, "connector.yaml");

  if (isDir && !fs.existsSync(manifest)) {
    io.log(
      `${resolved} has no connector.yaml. Mako will not discover this folder without one:\n\n  runtime: node\n`,
    );
    return 1;
  }

  // The same file Mako will run. Hardcoding connector.ts here would refuse a
  // folder the reconciler indexes perfectly well, which is the worst kind of
  // conformance gate: one that disagrees with production.
  const connectorFile = isDir
    ? path.join(resolved, entryFromManifest(manifest))
    : resolved;

  if (!fs.existsSync(connectorFile)) {
    io.log(`No connector at ${connectorFile}`);
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

  // ---- dependencies ----------------------------------------------------
  // What the push reconciler refuses, checked here first so the refusal is
  // not the first time an author hears of it.
  if (isDir) {
    for (const [passed, text] of dependencyChecks(resolved)) {
      if (passed === null) lines.push(skip(text));
      else record(passed, text);
    }
  }

  // ---- what Mako says ----------------------------------------------------
  if (flags.remote) {
    const [passed, text] = await remoteStatus(
      ctx,
      isDir ? resolved : connectorFolderOf(resolved),
    );
    if (passed === null) lines.push(skip(text));
    else record(passed, text);
  }

  // ---- spec ------------------------------------------------------------
  const specRun = await runCommand(runner, connectorFile, "spec");
  const spec = first(specRun.messages, "SPEC")?.spec;
  if (specRun.code !== 0 || !spec) {
    record(
      false,
      `spec: ${traceError(specRun.messages) ?? specRun.stderr.trim() ?? "no SPEC emitted"}`,
    );
    io.log(lines.join("\n"));
    return 1;
  }
  record(true, `spec: ${spec.mako?.name ?? "?"} v${spec.mako?.version ?? "?"}`);
  record(
    specRun.malformed.length === 0,
    `spec: stdout carried only protocol messages`,
  );

  const connectionSpecification = spec.connectionSpecification;
  const properties = connectionSpecification?.properties ?? {};
  // The server blocks a spec whose `properties` is absent, because an absent
  // field list is indistinguishable from an unreadable one and would store
  // every credential in plaintext. Say the same thing here, or the gate
  // passes a connector the push will refuse.
  const declaresFields =
    Boolean(connectionSpecification) &&
    connectionSpecification.properties !== undefined &&
    connectionSpecification.properties !== null &&
    typeof connectionSpecification.properties === "object" &&
    !Array.isArray(connectionSpecification.properties);
  record(
    declaresFields,
    declaresFields
      ? "spec: declares connectionSpecification.properties, so a credential form can be rendered"
      : "spec: needs `config: { properties }` in defineConnector — without it Mako blocks the connector, because no field could be marked secret",
  );
  const secrets = Object.entries(properties).filter(
    ([, property]) => property?.airbyte_secret === true,
  );
  const secretLooking = Object.keys(properties).filter(name =>
    /key|token|secret|password|credential/i.test(name),
  );
  const unmarked = secretLooking.filter(
    name => properties[name]?.airbyte_secret !== true,
  );
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
  const checkRun = await runCommand(runner, connectorFile, "check", {
    config: configPath,
  });
  const status = first(
    checkRun.messages,
    "CONNECTION_STATUS",
  )?.connectionStatus;
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
  const discoverRun = await runCommand(runner, connectorFile, "discover", {
    config: configPath,
  });
  const streams =
    first(discoverRun.messages, "CATALOG")?.catalog?.streams ?? [];
  record(streams.length > 0, `discover: ${streams.length} stream(s)`);

  const wanted = flags.entity
    ? streams.filter(s => s.name === String(flags.entity))
    : streams;
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
      JSON.stringify({
        streams: [{ stream: { name: stream.name }, sync_mode: "full_refresh" }],
      }),
    );

    const firstChunk = await runCommand(runner, connectorFile, "read", {
      config: configPath,
      catalog: catalogPath,
      "max-iterations": 1,
    });
    const records = firstChunk.messages.filter(m => m.type === "RECORD");
    const state = firstChunk.messages
      .filter(m => m.type === "STATE")
      .at(-1)?.state;

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
          mismatches.push(
            `${field} declared ${types.join("|")} but emitted ${seen}`,
          );
        }
      }
      record(
        mismatches.length === 0,
        mismatches.length === 0
          ? `${stream.name}: emitted records match the declared schema`
          : `${stream.name}: ${mismatches.join("; ")}`,
      );

      const undeclared = Object.keys(sample).filter(
        field => !(field in declared),
      );
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
      const secondRecords = secondChunk.messages.filter(
        m => m.type === "RECORD",
      );
      const firstIds = new Set(records.map(m => JSON.stringify(m.record.data)));
      const repeated = secondRecords.filter(m =>
        firstIds.has(JSON.stringify(m.record.data)),
      );
      record(
        repeated.length === 0 && secondRecords.length > 0,
        repeated.length > 0
          ? `${stream.name}: resuming re-read ${repeated.length} record(s) — the state does not advance, so a sync would loop`
          : secondRecords.length === 0
            ? `${stream.name}: resuming returned nothing although the first chunk said there was more`
            : `${stream.name}: resumes cleanly (${secondRecords.length} further record(s), none repeated)`,
      );
    } else {
      lines.push(
        skip(
          `${stream.name}: fits in one chunk, so resumption was not exercised`,
        ),
      );
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
