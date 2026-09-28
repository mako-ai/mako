/**
 * Dev builds of a data binding — the laptop half of "edit the SQL, see the
 * data" (the server behind `makoData()`'s `__data/<name>.parquet`).
 *
 * Every other path builds a binding from the REPO: materialize, the
 * scheduler, publish and refresh all read `bindings/<name>.sql` at a commit
 * or at the actor's view. A laptop edits files the API cannot see, so its dev
 * server sends the file's text instead, and this module answers with the
 * parquet of exactly that text, through the same connection resolution, the
 * same read-only gate and the same schema probe (`buildResolvedBindingParquet`
 * — there is no second builder).
 *
 * What it must never do is change what anyone else reads. So:
 *
 *   - text identical to the committed binding, rendered against the prod-like
 *     dbt schema, IS the committed binding: served from its stored artifact,
 *     or materialized exactly as `POST …/materialize` would (stored, run
 *     recorded) when there is none or the caller asked to refresh;
 *   - anything else — an uncommitted edit, or `{{ dbt_schema }}` rendered
 *     against a developer's environment — is a DRAFT: built and streamed
 *     back. Never stored as the app's artifact and never recorded as a run,
 *     so no published viewer can ever see uncommitted SQL or a personal
 *     schema. A draft is kept for half an hour under its own
 *     `apps/drafts/<project>/…` key (binding-draft-cache.ts) so a cold
 *     laptop cache does not re-run it, and a draft that keeps failing is
 *     refused for a growing window instead of re-run on every reload.
 *
 * Reading an already-built committed artifact needs read access (what `GET
 * …/artifact` needs); building anything needs write access (what
 * materialize needs).
 */
import type {
  IAppProject,
  IDatabaseConnection,
} from "../database/workspace-schema";
import {
  bindingArtifactKey,
  buildResolvedBindingParquet,
  materializeAppBinding,
  normalizeBindingText,
  readCommittedBinding,
  resolveDraftBinding,
  sameBindingDefinition,
  type AppBinding,
} from "./bindings.service";
import { resolveDbtBoundCode } from "../dbt/dbt-environments.service";
import {
  dbtSchemaReferences,
  devRelationListerFor,
  latestDevModification,
  type DevRelationListing,
} from "../dbt/dbt-defer";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  draftHash,
  forgetDraftBuild,
  lookupDraft,
  recordDraftBuilt,
  recordDraftFailed,
} from "./binding-draft-cache";
import { loggers } from "../logging";

const logger = loggers.api("apps");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface DevBuildInput {
  project: IAppProject;
  name: string;
  /** Whose view of the repo decides what "committed" means. */
  actorId: string;
  /** The signed-in user, when there is one — owns personal dbt environments. */
  userId?: string;
  /** May the caller build (write access), or only read what is built? */
  canWrite: boolean;
  /** The laptop's `bindings/<name>.sql`, front matter included. */
  source: string;
  /** Render `{{ dbt_schema }}` against this dbt environment instead of prod. */
  dbtEnvironment?: string;
  /**
   * With `dbtEnvironment`: relations the environment has not built render
   * to prod (`dbt --defer`). Default true; false renders every reference to
   * the environment.
   */
  dbtDefer?: boolean;
  /** Rebuild even when a stored artifact would answer. */
  refresh?: boolean;
}

export type DevBuildResult =
  | {
      /**
       * A stored artifact answers as-is: the committed binding's, or a
       * recent build of this exact draft (binding-draft-cache.ts).
       */
      kind: "artifact";
      artifactKey: string;
      source: "committed" | "draft-cache";
    }
  | {
      /**
       * "materialized": the committed binding, rebuilt and stored.
       * "draft": uncommitted text or a dev dbt schema — built now; kept only
       * as a short-lived draft, never as the app's artifact.
       */
      kind: "materialized" | "draft";
      /** Local temp file; the caller streams it and deletes it. */
      filePath: string;
      rowCount: number;
      byteSize: number;
      builtAt: Date;
    };

export class DevBuildError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 502 | 503,
    /** 503 only: when the same draft may be tried again. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DevBuildError";
  }
}

/** Swappable for tests; production wires the real services. */
export interface DevBuildDeps {
  resolveDraft: (
    project: IAppProject,
    name: string,
    source: string,
    actorId: string,
  ) => Promise<{ binding: AppBinding; connection: IDatabaseConnection }>;
  /** The committed binding (actor's view), or null when there is none. */
  committedBinding: (
    project: IAppProject,
    name: string,
    actorId: string,
  ) => Promise<AppBinding | null>;
  /**
   * binding.code with `{{ dbt_schema }}` rendered (prod without
   * `environment`), and — with one — when the newest dev relation it reads
   * was last written (the draft cache's freshness signal).
   */
  render: (
    project: IAppProject,
    binding: AppBinding,
    connection: IDatabaseConnection,
    environment?: { name: string; userId?: string; defer: boolean },
  ) => Promise<{ code: string; devModifiedAt?: number | null }>;
  artifactExists: (key: string) => Promise<boolean>;
  /** Materialize exactly `resolved` — never a re-read of the repo. */
  materialize: (
    project: IAppProject,
    resolved: { binding: AppBinding; connection: IDatabaseConnection },
    actorId: string,
  ) => Promise<{
    rowCount: number;
    byteSize: number;
    materializedAt: Date;
    filePath?: string;
  }>;
  build: (
    project: IAppProject,
    binding: AppBinding,
    connection: IDatabaseConnection,
    code: string,
  ) => Promise<{ filePath: string; rowCount: number; byteSize: number }>;
  drafts: {
    lookup: typeof lookupDraft;
    built: typeof recordDraftBuilt;
    failed: typeof recordDraftFailed;
    forget: typeof forgetDraftBuild;
  };
}

const defaultDeps: DevBuildDeps = {
  resolveDraft: resolveDraftBinding,
  committedBinding: readCommittedBinding,
  render: async (project, binding, connection, environment) => {
    if (!environment) {
      return {
        code: await resolveDbtBoundCode({
          workspaceId: project.workspaceId,
          dbtProjectId: binding.dbtProjectId,
          code: binding.code,
        }),
      };
    }
    // One listing serves both defer (when on) and freshness (always).
    const lister = devRelationListerFor(connection);
    let listing: DevRelationListing | null = null;
    const code = await resolveDbtBoundCode({
      workspaceId: project.workspaceId,
      dbtProjectId: binding.dbtProjectId,
      code: binding.code,
      environment: {
        name: environment.name,
        userId: environment.userId,
        listDevRelations: async (schema, refs) => {
          listing = await lister(schema, refs);
          return environment.defer ? listing : null;
        },
      },
    });
    return {
      code,
      devModifiedAt: latestDevModification(
        listing,
        dbtSchemaReferences(binding.code),
      ),
    };
  },
  artifactExists: key => getDashboardArtifactStore().exists(key),
  materialize: (project, resolved, actorId) =>
    materializeAppBinding(project, resolved.binding.name, actorId, {
      keepFile: true,
      resolved,
    }),
  build: buildResolvedBindingParquet,
  drafts: {
    lookup: lookupDraft,
    built: recordDraftBuilt,
    failed: recordDraftFailed,
    forget: forgetDraftBuild,
  },
};

export async function devBuildAppBinding(
  input: DevBuildInput,
  deps: DevBuildDeps = defaultDeps,
): Promise<DevBuildResult> {
  const { project, name, actorId } = input;
  if (!NAME_RE.test(name)) {
    throw new DevBuildError("Invalid binding name", 400);
  }

  let draft: { binding: AppBinding; connection: IDatabaseConnection };
  let rendered: { code: string; devModifiedAt?: number | null };
  let asPublished: boolean;
  try {
    // A CRLF checkout of the committed file is the committed file.
    draft = await deps.resolveDraft(
      project,
      name,
      normalizeBindingText(input.source),
      actorId,
    );
    rendered = await deps.render(
      project,
      draft.binding,
      draft.connection,
      input.dbtEnvironment
        ? {
            name: input.dbtEnvironment,
            userId: input.userId,
            defer: input.dbtDefer !== false,
          }
        : undefined,
    );
    // A dev environment that renders to the same SQL as prod (it IS the
    // prod environment, or the binding has no `{{ dbt_schema }}`) changes
    // nothing, so it must not demote a committed binding to a draft.
    asPublished =
      !input.dbtEnvironment ||
      rendered.code ===
        (
          await deps
            .render(project, draft.binding, draft.connection)
            .catch(() => undefined)
        )?.code;
  } catch (error) {
    // No connection, a connection outside this workspace, an unknown or
    // someone else's dbt environment: the request is wrong, nothing ran.
    const message = error instanceof Error ? error.message : String(error);
    throw new DevBuildError(message, 400);
  }

  // Committed = the whole definition matches (connection, database, dbt
  // link, materialization, query), not just the artifact key, which ignores
  // the dbt link and the mode. From here on the COMMITTED binding is what is
  // served or built: its key is the one published readers resolve, and
  // materializing it as read here (not re-read by name) means a commit
  // landing mid-request cannot put other SQL under this caller's text.
  const committed = asPublished
    ? await deps.committedBinding(project, name, actorId)
    : null;
  const isCommitted =
    committed !== null &&
    committed.materialization === "parquet" &&
    sameBindingDefinition(committed, draft.binding);
  const committedKey = isCommitted ? bindingArtifactKey(committed) : null;

  if (
    committedKey &&
    !input.refresh &&
    (await deps.artifactExists(committedKey))
  ) {
    return { kind: "artifact", artifactKey: committedKey, source: "committed" };
  }
  if (!input.canWrite) {
    throw new DevBuildError(
      isCommitted
        ? `Binding "${name}" is not materialized yet, and you have read-only access to this app`
        : `Your bindings/${name}.sql differs from the committed one; building uncommitted SQL needs edit access to this app`,
      403,
    );
  }

  const projectId = project._id.toString();
  const hash = draftHash({
    connectionId: draft.binding.connectionId,
    databaseId: draft.binding.databaseId,
    databaseName: draft.binding.databaseName,
    renderedCode: rendered.code,
    devModifiedAt: rendered.devModifiedAt ?? null,
  });
  if (!isCommitted && !input.refresh) {
    // An explicit refresh skips both: it rebuilds, and a person clicking it
    // is not the reload loop the backoff exists for.
    let cached = await deps.drafts.lookup(projectId, hash);
    if (cached.kind === "hit" && !(await deps.artifactExists(cached.key))) {
      // Its object is gone: forget the row and decide again (a miss, or the
      // backoff if this draft has been failing).
      await deps.drafts.forget(projectId, cached.key);
      cached = await deps.drafts.lookup(projectId, hash);
      if (cached.kind === "hit") cached = { kind: "miss" };
    }
    if (cached.kind === "hit") {
      return {
        kind: "artifact",
        artifactKey: cached.key,
        source: "draft-cache",
      };
    }
    if (cached.kind === "cooling") {
      throw new DevBuildError(
        `This query failed ${cached.failures} time(s) in a row and is not being re-run yet: ${cached.error}`,
        503,
        cached.retryAfterMs,
      );
    }
  }

  try {
    if (isCommitted && committed) {
      const result = await deps.materialize(
        project,
        { binding: committed, connection: draft.connection },
        actorId,
      );
      if (!result.filePath) throw new Error("Materialize kept no file");
      return {
        kind: "materialized",
        filePath: result.filePath,
        rowCount: result.rowCount,
        byteSize: result.byteSize,
        builtAt: result.materializedAt,
      };
    }
    let built: { filePath: string; rowCount: number; byteSize: number };
    try {
      built = await deps.build(
        project,
        draft.binding,
        draft.connection,
        rendered.code,
      );
    } catch (error) {
      await deps.drafts
        .failed({
          projectId,
          name,
          hash,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }
    try {
      await deps.drafts.built({ projectId, name, hash, ...built });
    } catch (error) {
      // Not keeping it only costs the next request a rebuild.
      logger.warn("Could not keep draft build", {
        projectId,
        binding: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info("Apps binding dev build", {
      projectId: project._id.toString(),
      binding: name,
      rowCount: built.rowCount,
      dbtEnvironment: input.dbtEnvironment,
    });
    return { kind: "draft", ...built, builtAt: new Date() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Apps binding dev build failed", {
      projectId: project._id.toString(),
      binding: name,
      error: message,
    });
    throw new DevBuildError(message, 502);
  }
}
