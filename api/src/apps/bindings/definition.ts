/**
 * A binding file: its front matter, the identity that keys its artifact,
 * and reading bindings from a branch, main or a commit.
 */
import { isValidBindingName } from "../binding-name";
import { createHash } from "node:crypto";
import { type IAppProject } from "../../database/workspace-schema";
import { globFiles, readFile } from "../worktree.service";
import { freshenForServe } from "../cloud-repo.service";

export interface AppBinding {
  name: string;
  connectionId: string;
  /**
   * "parquet" = materialized to a stored artifact (default, scheduled).
   * "live" = re-queried on demand and served fresh, no artifact. Live is
   * dev/edit-mode only for now (a published app has no authorized data
   * path yet — apps.md §13.4.1).
   */
  materialization: "parquet" | "live";
  /** Cron expression from `-- schedule:` front matter (Block 4 consumes it). */
  schedule?: string;
  /** IANA timezone for the schedule (`-- timezone:`), when the source had one. */
  timezone?: string;
  /** From `-- dbt_project:` front matter ({{ dbt_schema }} rendering, later). */
  dbtProjectId?: string;
  /** `-- database:` / `-- database_name:` for connections that need one selected. */
  databaseId?: string;
  databaseName?: string;
  /**
   * `-- row_limit:` as written (e.g. `3000000`, `3M`). Resolved and checked
   * against PARQUET_MAX_ROW_LIMIT at build time (resolveBindingRowLimit), so
   * a typo fails that binding's build with a message, never its serving.
   * Absent = PARQUET_ROW_LIMIT. Not part of the artifact identity: a build
   * that succeeds holds the whole result whatever the limit was.
   */
  rowLimit?: string;
  /** The whole file, front matter included. */
  sql: string;
  /** The executable part: the file with its leading comment block removed. */
  code: string;
}

/** The parts of a binding that determine its result — and thus its artifact. */
export interface BindingArtifactIdentity {
  connectionId: string;
  databaseId?: string;
  databaseName?: string;
  /** SQL with front matter already stripped (AppBinding.code). */
  code: string;
}

/**
 * A hash of a binding's DEFINITION (connection + database + query), not its
 * data. Stable while the query is unchanged; changes the moment the query
 * does.
 */
export function bindingDefinitionHash(b: BindingArtifactIdentity): string {
  const canon = [
    b.connectionId,
    b.databaseId ?? "",
    b.databaseName ?? "",
    b.code.trim(),
  ].join("\u0000");
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/**
 * Content-addressed artifact key: identical queries (same connection, same
 * SQL) resolve to the SAME parquet file, wherever they live. So two apps — or
 * a v1 app and its v2 migration, or two branches of one app — that run the
 * same binding share ONE artifact (materialize once, no duplication, no double
 * cost), and a query EDIT lands at a new key rather than overwriting the file
 * an older commit still reads. This replaced the per-(project,name) key, which
 * duplicated data and could serve a stale build after an edit.
 */
export function bindingArtifactKey(b: BindingArtifactIdentity): string {
  return `apps/bindings/${b.connectionId}/${bindingDefinitionHash(b)}.parquet`;
}

/**
 * The artifact key for a binding addressed by name — resolves the binding from
 * the project (repo) to get its definition. Returns null when no such binding
 * exists. For callers (preview/publish/serve) that hold only a name.
 */
export async function bindingArtifactKeyByName(
  project: IAppProject,
  name: string,
  actorId: string,
  /** Resolve the binding as of this commit (published serving). */
  at?: string,
): Promise<string | null> {
  if (!isValidBindingName(name)) return null;
  // ONE binding file, not every binding in the app. This is the serving path
  // — each `__data/<name>.parquet` request resolves its key here — and every
  // file read re-resolves the actor's source, which asks the sandbox provider
  // whether a live box should answer instead of the commit. Reading all N
  // bindings therefore cost N of those probes, so a 16-binding app spent ~30s
  // of round trips before streaming a parquet whose bytes take milliseconds.
  // Reading only what was asked for also means a malformed NEIGHBOUR (no
  // connection, bad filename) no longer 500s a healthy binding's data.
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId, at);
  } catch {
    return null;
  }
  const meta = parseBindingFrontMatter(file.contents);
  const connectionId =
    meta.connection ??
    (await legacyConnectionIds(project, actorId, at)).get(name);
  if (!connectionId) {
    throw new Error(
      `Binding "${name}" has no connection — add "-- connection: <id>" front matter to bindings/${name}.sql`,
    );
  }
  return bindingArtifactKey({
    connectionId,
    databaseId: meta.database,
    databaseName: meta.database_name,
    code: stripBindingFrontMatter(file.contents),
  });
}

/**
 * git's wording for a path absent from a tree, and a sandbox's for a file.
 * E2B reads a missing file as `FileNotFoundError: path '<p>' does not exist`
 * (no " in"), so a binding that is only in the live box's draft — a new
 * `bindings/<name>.sql` not committed yet — must match too, or every dev
 * build of it fails instead of building the draft.
 */
export function isFileMissingError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof Error && e.name === "FileNotFoundError") return true;
    e =
      e && typeof e === "object" && "cause" in e
        ? (e as { cause: unknown }).cause
        : null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr: unknown }).stderr)
      : "";
  return /does not exist in|path '[^']*' does not exist|exists on disk, but not in|no such file|enoent|file not found/i.test(
    `${message}\n${stderr}`,
  );
}

/**
 * ONE committed binding, parsed — the same narrow single-file read as
 * bindingArtifactKeyByName. Null when there is no such file or it names no
 * connection.
 */
export async function readCommittedBinding(
  project: IAppProject,
  name: string,
  /** Whose view to read; undefined reads the default branch in git. */
  actorId: string | undefined,
  /** Read the binding as of this commit rather than the actor's view. */
  at?: string,
): Promise<AppBinding | null> {
  if (!isValidBindingName(name)) return null;
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId, at);
  } catch (error) {
    // Only a file that is not there reads as "no such binding". A commit this
    // instance cannot get says nothing about the binding, and the caller must
    // not treat that as the binding being gone.
    if (isFileMissingError(error)) return null;
    throw error;
  }
  const legacy = parseBindingFrontMatter(file.contents).connection
    ? undefined
    : (await legacyConnectionIds(project, actorId, at)).get(name);
  return bindingFromSource(name, file.contents, legacy);
}

/**
 * ONE binding as committed on the workspace repo's default branch (main), read
 * from git after a freshen from the mirror. Never the actor's sandbox: a laptop
 * checkout pushes to main, while the person's cloud sandbox may sit at any
 * older commit. Reading through the sandbox made a binding added on main read
 * as missing (or as its older text) whenever the box had not pulled since.
 * Null when main has no such binding or it names no connection.
 */
export async function readMainBinding(
  project: IAppProject,
  name: string,
): Promise<AppBinding | null> {
  if (!isValidBindingName(name)) return null;
  // Best-effort and throttled: a mirror that cannot be reached leaves the
  // local copy of main, which is still never a sandbox.
  await freshenForServe(project.workspaceId.toString());
  return readCommittedBinding(project, name, undefined);
}

/** No `bindings/<name>.sql` where the build looked for it. */
export class BindingNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "BindingNotFoundError";
  }
}

/** CRLF/CR → LF, no trailing whitespace at the end — not part of a query. */
export function normalizeBindingText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

/**
 * Do two bindings produce the same data? Everything that decides the result
 * (connection, database, dbt link, materialization mode, the query), with line
 * endings normalised so a CRLF checkout of the same file still matches. The
 * row limit counts too: it decides whether a build succeeds, so a draft that
 * only raises it must build with its own limit, not the committed one.
 * Scheduling fields do not change the data and are ignored.
 */
export function sameBindingDefinition(a: AppBinding, b: AppBinding): boolean {
  return (
    a.connectionId === b.connectionId &&
    (a.rowLimit?.trim() ?? "") === (b.rowLimit?.trim() ?? "") &&
    (a.databaseId ?? "") === (b.databaseId ?? "") &&
    (a.databaseName ?? "") === (b.databaseName ?? "") &&
    (a.dbtProjectId ?? "") === (b.dbtProjectId ?? "") &&
    a.materialization === b.materialization &&
    normalizeBindingText(a.code).trim() === normalizeBindingText(b.code).trim()
  );
}

/**
 * How ONE binding is materialized, from its file alone — the same narrow
 * single-file read the serving path uses, for the same reason (a malformed
 * neighbour must not decide this binding's fate). Null when there is no such
 * binding.
 */
export async function readBindingMaterialization(
  project: IAppProject,
  name: string,
  actorId: string,
  at?: string,
): Promise<AppBinding["materialization"] | null> {
  if (!isValidBindingName(name)) return null;
  let file: { contents: string };
  try {
    file = await readFile(project, `bindings/${name}.sql`, actorId, at);
  } catch {
    return null;
  }
  const meta = parseBindingFrontMatter(file.contents);
  return meta.materialization === "live" ? "live" : "parquet";
}

/**
 * v1 kept each binding's connection in mako.json. Front matter is the source
 * of truth now; this is the fallback for files written before it, read only
 * when a binding has no `-- connection:` line.
 */
export async function legacyConnectionIds(
  project: IAppProject,
  actorId: string | undefined,
  at?: string,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  try {
    const raw = await readFile(project, "mako.json", actorId, at);
    const manifest = JSON.parse(raw.contents) as {
      bindings?: Array<{ name?: string; connectionId?: string }>;
    };
    for (const b of manifest.bindings ?? []) {
      if (b.name && b.connectionId) byName.set(b.name, b.connectionId);
    }
  } catch {
    // No manifest — fine; front matter is the source of truth anyway.
  }
  return byName;
}

/**
 * Parse a binding file's leading SQL-comment front matter:
 *
 *   -- connection: <workspace connection id>   (required)
 *   -- materialization: parquet                (default)
 *   -- schedule: 0 6 * * *                     (optional, cron)
 *   -- dbt_project: <id>                       (optional)
 *   -- row_limit: 3000000                      (optional, rows; also 3M)
 *
 * The block ends at the first non-comment line; unknown keys are ignored.
 * Stays valid SQL for every editor/highlighter, and — unlike a central
 * manifest — two conversation branches adding bindings can never conflict.
 */
/**
 * Front matter is the leading block of comment lines, `-- key: value` in SQL
 * files and `// key: value` in JavaScript (MongoDB) files. The first
 * non-comment line ends it.
 */
export function parseBindingFrontMatter(
  source: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "--" || trimmed === "//") continue;
    const m = trimmed.match(
      /^(?:--|\/\/)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/,
    );
    if (!m) {
      if (trimmed.startsWith("--") || trimmed.startsWith("//")) continue;
      break;
    }
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/** The file without its leading comment block — what actually executes. */
export function stripBindingFrontMatter(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("--") || t.startsWith("//")) i++;
    else break;
  }
  return lines.slice(i).join("\n");
}

/**
 * Read the project's bindings from git at the given actor's view of the
 * tree. A binding is `bindings/<name>.sql` with front matter (name =
 * filename, discovery = glob) — no central manifest. Legacy fallback: a
 * mako.json `bindings[]` entry supplies connectionId for files without a
 * `-- connection:` line, until migrated.
 */
export async function readBindings(
  project: IAppProject,
  actorId: string,
  /**
   * Read the bindings as of this commit rather than the actor's view. A
   * published deployment is a build of one commit; its data is defined by
   * the binding files at that same commit.
   */
  at?: string,
): Promise<AppBinding[]> {
  const { bindings, skipped } = await readBindingsTolerant(
    project,
    actorId,
    at,
  );
  if (skipped.length > 0) throw new Error(skipped[0].error);
  return bindings;
}

export interface BindingsReadResult {
  bindings: AppBinding[];
  /** Files under bindings/ that are not servable bindings, and why. */
  skipped: Array<{ path: string; error: string }>;
}

/**
 * readBindings that reports malformed files instead of refusing the whole
 * set. The serving path already isolates a malformed neighbour (a bad
 * filename or a missing connection only breaks ITS data URL); publish must
 * match, or a stray `bindings/draft (copy).sql` committed alongside a code
 * fix pins the app at its previous deployment — every publish, every
 * rollback to any sha containing the file, and the hourly reconcile
 * re-enqueuing the same failure.
 */
export async function readBindingsTolerant(
  project: IAppProject,
  actorId: string,
  at?: string,
): Promise<BindingsReadResult> {
  const legacyByName = await legacyConnectionIds(project, actorId, at);

  const paths = await globFiles(
    project,
    "bindings/*.sql",
    actorId,
    undefined,
    at,
  );
  const out: AppBinding[] = [];
  const skipped: BindingsReadResult["skipped"] = [];
  for (const path of paths) {
    const name = path.replace(/^bindings\//, "").replace(/\.sql$/, "");
    if (!isValidBindingName(name)) {
      skipped.push({ path, error: `Invalid binding filename: ${path}` });
      continue;
    }
    const file = await readFile(project, path, actorId, at);
    const binding = bindingFromSource(
      name,
      file.contents,
      legacyByName.get(name),
    );
    if (!binding) {
      skipped.push({
        path,
        error: `Binding "${name}" has no connection — add "-- connection: <id>" front matter to ${path}`,
      });
      continue;
    }
    out.push(binding);
  }
  return { bindings: out, skipped };
}

/**
 * One binding from its file's text. Null when neither the front matter nor
 * the legacy manifest names a connection. Shared by the repo read and the
 * dev build (which receives the text from a laptop instead of the repo), so
 * both parse a binding identically.
 */
export function bindingFromSource(
  name: string,
  source: string,
  legacyConnectionId?: string,
): AppBinding | null {
  const meta = parseBindingFrontMatter(source);
  const connectionId = meta.connection ?? legacyConnectionId;
  if (!connectionId) return null;
  return {
    name,
    connectionId,
    materialization: meta.materialization === "live" ? "live" : "parquet",
    schedule: meta.schedule,
    timezone: meta.timezone,
    dbtProjectId: meta.dbt_project,
    databaseId: meta.database,
    databaseName: meta.database_name,
    rowLimit: meta.row_limit ?? meta.rowlimit,
    sql: source,
    code: stripBindingFrontMatter(source),
  };
}
