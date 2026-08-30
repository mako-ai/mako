/* eslint-disable no-console */
/**
 * Team secret store, backed by Google Secret Manager.
 *
 * The problem this solves: `.env` is gitignored, so the only copy of a value
 * is on whichever laptop created it. We have already lost an E2B API key that
 * way. A new developer joining had no way to get a working environment short
 * of asking someone to hand over secrets over chat.
 *
 * Now: `gcloud auth login` then `pnpm secrets:pull`, and that is the whole
 * onboarding step. Secrets live per-variable (not as one blob) so a single
 * value can be rotated, granted, or referenced directly by Cloud Run later.
 *
 *   pnpm secrets:pull              write .env from the dev project
 *   pnpm secrets:push              upload local .env values as new versions
 *   pnpm secrets:list              what is stored (names only, never values)
 *   pnpm secrets:diff              which names differ local vs stored
 *   pnpm secrets:salvage-prod      capture prod Cloud Run env into prod secrets
 *
 * Add `--env prod` to target mako-ai-prod, `--dry-run` to preview any
 * mutation. Values are NEVER printed by any command; output is names and
 * status only, so it is safe to paste a run into a ticket.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");

const PROJECTS = { dev: "mako-ai-dev", prod: "mako-ai-prod" } as const;
type EnvName = keyof typeof PROJECTS;

/** Parallel gcloud calls. Enough to keep a pull under ~10s, gentle on quota. */
const CONCURRENCY = 8;

/**
 * Never store these: they are machine-specific or derived, and syncing them
 * would hand every developer someone else's local paths and toggles.
 */
const LOCAL_ONLY = new Set([
  "APPS_V2_SANDBOX_PROVIDER",
  "APPS_V2_GIT_ROOT",
  "APPS_V2_SESSIONS_ROOT",
  "NODE_ENV",
  // The connected-repo push OPT-IN is per-machine by doctrine (§13.17):
  // dev DBs are prod clones carrying real customer bindings, so a synced
  // "allow" would arm mirror pushes on every machine that pulls .env.
  "APPS_V2_CONNECTED_REPO_PUSH",
  // A named tunnel is one machine's identity; its credentials live in that
  // machine's ~/.cloudflared and the hostname is useless anywhere else.
  "APPS_V2_TUNNEL_NAME",
  "APPS_V2_TUNNEL_HOSTNAME",
]);

interface Assignment {
  key: string;
  /** Raw right-hand side exactly as written, quotes included. */
  raw: string;
}

function parseEnv(text: string): Assignment[] {
  const out: Assignment[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.push({ key: m[1], raw: m[2] });
  }
  return out;
}

async function gcloud(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gcloud", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** Run `task` over `items` with a bounded number in flight. */
async function pool<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await task(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function listSecrets(project: string): Promise<string[]> {
  const out = await gcloud([
    "secrets",
    "list",
    `--project=${project}`,
    "--format=value(name)",
  ]);
  return out
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split("/").pop()!);
}

async function readSecret(
  project: string,
  name: string,
): Promise<string | null> {
  try {
    return await gcloud([
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${name}`,
      `--project=${project}`,
    ]);
  } catch {
    return null;
  }
}

async function writeSecret(
  project: string,
  name: string,
  value: string,
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await readSecret(project, name);
  if (existing !== null && existing === value) return "unchanged";
  if (existing === null) {
    // Create the container EMPTY. Passing --data-file=- here would make gcloud
    // block forever waiting on a stdin we are not writing; the value goes in
    // as a version below.
    await gcloud([
      "secrets",
      "create",
      name,
      `--project=${project}`,
      "--replication-policy=automatic",
    ]).catch(() => undefined); // already exists, or raced
  }
  // gcloud reads the value from stdin so it never appears in argv (and so
  // never in `ps`, shell history, or a CI log).
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "gcloud",
      [
        "secrets",
        "versions",
        "add",
        name,
        `--project=${project}`,
        "--data-file=-",
      ],
      err => (err ? reject(err) : resolve()),
    );
    child.stdin?.end(value);
  });
  return existing === null ? "created" : "updated";
}

async function cmdList(project: string): Promise<void> {
  const names = await listSecrets(project);
  console.log(`${names.length} secret(s) in ${project}:`);
  for (const n of names.sort()) console.log(`  ${n}`);
}

async function cmdPush(project: string, dryRun: boolean): Promise<void> {
  const local = parseEnv(await fs.readFile(ENV_PATH, "utf8")).filter(
    a => !LOCAL_ONLY.has(a.key) && a.raw !== "",
  );
  console.log(
    `${local.length} value(s) to push to ${project}` +
      (dryRun ? " (dry run)" : ""),
  );
  if (dryRun) {
    for (const a of local) console.log(`  would push ${a.key}`);
    return;
  }
  const results = await pool(local, async a => ({
    key: a.key,
    status: await writeSecret(project, a.key, a.raw),
  }));
  const by = (s: string) => results.filter(r => r.status === s).length;
  for (const r of results.filter(r => r.status !== "unchanged")) {
    console.log(`  ${r.status.padEnd(9)} ${r.key}`);
  }
  console.log(
    `done: ${by("created")} created, ${by("updated")} updated, ${by("unchanged")} unchanged`,
  );
}

async function cmdPull(project: string, dryRun: boolean): Promise<void> {
  const names = await listSecrets(project);
  if (names.length === 0) {
    console.log(
      `No secrets in ${project}. Seed it from a populated .env with: pnpm secrets:push`,
    );
    return;
  }
  const fetched = await pool(names, async name => ({
    name,
    value: await readSecret(project, name),
  }));
  const values = new Map(
    fetched.filter(f => f.value !== null).map(f => [f.name, f.value!]),
  );

  // Start from the existing .env when there is one, otherwise .env.example —
  // both carry the comments that explain what each variable is for, and a
  // generated file that drops them would be a downgrade.
  let template: string;
  let basedOn: string;
  try {
    template = await fs.readFile(ENV_PATH, "utf8");
    basedOn = ".env";
  } catch {
    template = await fs.readFile(ENV_EXAMPLE_PATH, "utf8");
    basedOn = ".env.example";
  }

  const seen = new Set<string>();
  const changed: string[] = [];
  const lines = template.split("\n").map(line => {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) return line;
    const [, key, raw] = m;
    if (!values.has(key)) return line;
    seen.add(key);
    const next = values.get(key)!;
    if (next !== raw) changed.push(key);
    return `${key}=${next}`;
  });

  const extra = [...values.keys()].filter(k => !seen.has(k)).sort();
  if (extra.length > 0) {
    lines.push("", "# Pulled from Secret Manager (not in the template).");
    for (const key of extra) lines.push(`${key}=${values.get(key)!}`);
  }

  console.log(
    `${values.size} secret(s) from ${project}, applied to ${basedOn}` +
      (dryRun ? " (dry run)" : ""),
  );
  for (const key of changed) console.log(`  updated  ${key}`);
  for (const key of extra) console.log(`  added    ${key}`);
  if (changed.length === 0 && extra.length === 0) {
    console.log("  .env already matches the store");
  }
  if (dryRun) return;

  if (basedOn === ".env") {
    const backup = `${ENV_PATH}.bak`;
    await fs.copyFile(ENV_PATH, backup);
    console.log(`previous .env backed up to ${path.basename(backup)}`);
  }
  await fs.writeFile(ENV_PATH, lines.join("\n"));
  console.log("wrote .env");
}

async function cmdDiff(project: string): Promise<void> {
  const local = new Map(
    parseEnv(await fs.readFile(ENV_PATH, "utf8")).map(a => [a.key, a.raw]),
  );
  const names = await listSecrets(project);
  const fetched = await pool(names, async name => ({
    name,
    value: await readSecret(project, name),
  }));
  const remote = new Map(
    fetched.filter(f => f.value !== null).map(f => [f.name, f.value!]),
  );

  const onlyLocal = [...local.keys()].filter(
    k => !remote.has(k) && !LOCAL_ONLY.has(k),
  );
  const onlyRemote = [...remote.keys()].filter(k => !local.has(k));
  const differing = [...local.keys()].filter(
    k => remote.has(k) && remote.get(k) !== local.get(k),
  );

  const report = (label: string, keys: string[]) => {
    console.log(`${label}: ${keys.length}`);
    for (const k of keys.sort()) console.log(`  ${k}`);
  };
  report("only in local .env (push to share)", onlyLocal);
  report("only in Secret Manager (pull to get)", onlyRemote);
  report("present in both, value differs", differing);
}

/**
 * Capture the live prod Cloud Run environment into the prod secret store.
 *
 * These values exist today only as Cloud Run env vars and GitHub Actions
 * secrets; neither is readable as a set, and the Actions copies cannot be read
 * back at all. This makes prod recoverable and rotatable.
 */
async function cmdSalvageProd(dryRun: boolean): Promise<void> {
  const project = PROJECTS.prod;
  const service = "mako";
  const region = "europe-west1";
  const raw = await gcloud([
    "run",
    "services",
    "describe",
    service,
    `--project=${project}`,
    `--region=${region}`,
    "--format=json",
  ]);
  const spec = JSON.parse(raw);
  const env: Array<{ name: string; value?: string }> =
    spec?.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const literal = env.filter(
    e =>
      typeof e.value === "string" && e.value !== "" && !LOCAL_ONLY.has(e.name),
  );
  console.log(
    `${literal.length} literal env var(s) on ${service} (${project})` +
      (dryRun ? " (dry run)" : ""),
  );
  if (dryRun) {
    for (const e of literal) console.log(`  would store ${e.name}`);
    return;
  }
  const results = await pool(literal, async e => ({
    key: e.name,
    status: await writeSecret(project, e.name, e.value!),
  }));
  for (const r of results.filter(r => r.status !== "unchanged")) {
    console.log(`  ${r.status.padEnd(9)} ${r.key}`);
  }
  console.log(`done: ${results.length} processed`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dryRun = argv.includes("--dry-run");
  const envIdx = argv.indexOf("--env");
  const envName = (envIdx >= 0 ? argv[envIdx + 1] : "dev") as EnvName;
  if (!(envName in PROJECTS)) {
    throw new Error(
      `--env must be one of: ${Object.keys(PROJECTS).join(", ")}`,
    );
  }
  const project = PROJECTS[envName];

  try {
    await gcloud(["auth", "print-access-token"]);
  } catch {
    throw new Error(
      "Not logged in to gcloud. Run `gcloud auth login`, then retry.",
    );
  }

  switch (cmd) {
    case "pull":
      return cmdPull(project, dryRun);
    case "push":
      return cmdPush(project, dryRun);
    case "list":
      return cmdList(project);
    case "diff":
      return cmdDiff(project);
    case "salvage-prod":
      return cmdSalvageProd(dryRun);
    default:
      console.log(
        [
          "Usage: pnpm secrets:<command> [--env dev|prod] [--dry-run]",
          "",
          "  pull           write .env from Secret Manager",
          "  push           upload local .env values as new versions",
          "  list           names of stored secrets (never values)",
          "  diff           which names differ, local vs stored",
          "  salvage-prod   capture prod Cloud Run env into prod secrets",
        ].join("\n"),
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
