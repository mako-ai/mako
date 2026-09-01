/**
 * dbt orchestration config as files (apps.md §23): the pure format layer.
 *
 * - `dbt/jobs/<slug>.yml` — ONE file per job (a central registry would be a
 *   merge-conflict magnet; per-file is the recorded doctrine). The filename
 *   slug is the job's identity; `name` inside is the display name.
 * - `dbt/environments.yml` — the project's environments + settings. A
 *   singleton by nature (one dbt project per workspace), so one file is not
 *   a registry-of-many.
 *
 * Credentials never appear here: environments reference a connection by id.
 * Run state (history, scheduler claims, failure counters) never appears
 * here: those are runtime fields on the Mongo index rows.
 */
import yaml from "js-yaml";

export const DBT_JOBS_DIR = "dbt/jobs";
export const DBT_ENVIRONMENTS_PATH = "dbt/environments.yml";

export interface DbtJobFile {
  name: string;
  environment: string;
  commands: string[];
  schedule?: { cron: string; timezone: string } | null;
  enabled: boolean;
  deferToProduction: boolean;
}

export interface DbtEnvironmentsFile {
  dbtVersion?: string;
  defaultEnvironment: string;
  prodEnvironment?: string;
  environments: Array<{
    name: string;
    connectionId: string;
    targetSchema: string;
    threads?: number;
    vars?: Record<string, unknown>;
    ownerUserId?: string;
  }>;
}

export function jobFilePath(slug: string): string {
  return `${DBT_JOBS_DIR}/${slug}.yml`;
}

export function slugFromJobFilePath(repoRelative: string): string | null {
  const m = repoRelative.match(/^dbt\/jobs\/([a-z0-9][a-z0-9-]*)\.yml$/);
  return m ? m[1] : null;
}

/** Stable filename identity for a job, derived once from its display name. */
export function slugifyJobName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "job";
}

export function serializeJobFile(job: DbtJobFile): string {
  const doc: Record<string, unknown> = {
    name: job.name,
    environment: job.environment,
    commands: job.commands,
  };
  if (job.schedule) {
    doc.schedule = {
      cron: job.schedule.cron,
      timezone: job.schedule.timezone,
    };
  }
  doc.enabled = job.enabled;
  if (job.deferToProduction) doc.defer_to_production = true;
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

export function parseJobFile(contents: string): DbtJobFile | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  const environment =
    typeof doc.environment === "string" ? doc.environment.trim() : "";
  const commands = Array.isArray(doc.commands)
    ? doc.commands.filter((c): c is string => typeof c === "string" && !!c)
    : [];
  if (!name || !environment || commands.length === 0) return null;
  let schedule: DbtJobFile["schedule"] = null;
  const s = doc.schedule as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    if (typeof s.cron === "string" && typeof s.timezone === "string") {
      schedule = { cron: s.cron, timezone: s.timezone };
    } else {
      return null; // half a schedule is a broken file, not "no schedule"
    }
  }
  return {
    name,
    environment,
    commands: commands.slice(0, 10),
    schedule,
    enabled: doc.enabled !== false,
    deferToProduction: doc.defer_to_production === true,
  };
}

export function serializeEnvironmentsFile(file: DbtEnvironmentsFile): string {
  const doc: Record<string, unknown> = {};
  if (file.dbtVersion) doc.dbt_version = file.dbtVersion;
  doc.default_environment = file.defaultEnvironment;
  if (file.prodEnvironment) doc.prod_environment = file.prodEnvironment;
  doc.environments = file.environments.map(env => {
    const e: Record<string, unknown> = {
      name: env.name,
      connection_id: env.connectionId,
      target_schema: env.targetSchema,
    };
    if (env.threads != null) e.threads = env.threads;
    if (env.vars && Object.keys(env.vars).length > 0) e.vars = env.vars;
    if (env.ownerUserId) e.owner_user_id = env.ownerUserId;
    return e;
  });
  return yaml.dump(doc, { lineWidth: 100, noRefs: true });
}

export function parseEnvironmentsFile(
  contents: string,
): DbtEnvironmentsFile | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const defaultEnvironment =
    typeof doc.default_environment === "string"
      ? doc.default_environment.trim()
      : "";
  const list = Array.isArray(doc.environments) ? doc.environments : [];
  const environments: DbtEnvironmentsFile["environments"] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const connectionId =
      typeof e.connection_id === "string" ? e.connection_id.trim() : "";
    const targetSchema =
      typeof e.target_schema === "string" ? e.target_schema.trim() : "";
    if (!name || !connectionId || !targetSchema) return null;
    environments.push({
      name,
      connectionId,
      targetSchema,
      threads: typeof e.threads === "number" ? e.threads : undefined,
      vars:
        e.vars && typeof e.vars === "object"
          ? (e.vars as Record<string, unknown>)
          : undefined,
      ownerUserId:
        typeof e.owner_user_id === "string" ? e.owner_user_id : undefined,
    });
  }
  if (!defaultEnvironment || environments.length === 0) return null;
  if (!environments.some(e => e.name === defaultEnvironment)) return null;
  return {
    dbtVersion:
      typeof doc.dbt_version === "string" ? doc.dbt_version : undefined,
    defaultEnvironment,
    prodEnvironment:
      typeof doc.prod_environment === "string"
        ? doc.prod_environment
        : undefined,
    environments,
  };
}
