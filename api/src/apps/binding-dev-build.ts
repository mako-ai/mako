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
 * The laptop's text is the whole input. A dev build never reads, starts or
 * waits on the caller's cloud sandbox (that box is for working inside
 * app.mako.ai and may sit at any older commit), and a writer's build reads no
 * repo state at all. It used to resolve "the committed binding" through the
 * sandbox, so a binding pushed to main after the box last pulled answered
 * HTTP 500 (`path '…/bindings/<name>.sql' does not exist`).
 *
 * What it must never do is change what anyone else reads. So:
 *
 *   - text whose content-addressed build is already stored (the published
 *     binding, rendered against the prod-like dbt schema) is served from
 *     that artifact;
 *   - anything else — an edit, a binding only on the laptop, a refresh, or
 *     `{{ dbt_schema }}` rendered against a developer's environment — is a
 *     DRAFT: built and streamed back. Never stored as the app's artifact and
 *     never recorded as a run, so no published viewer can ever see
 *     uncommitted SQL or a personal schema. Stored artifacts are built by
 *     the production paths (publish, schedule, materialize). A draft is kept
 *     for half an hour under its own `apps/drafts/<project>/…` key
 *     (binding-draft-cache.ts) so a cold laptop cache does not re-run it,
 *     and a draft that keeps failing is refused for a growing window instead
 *     of re-run on every reload.
 *
 * Building anything needs write access (what materialize needs). A
 * read-only caller gets only the stored artifact of the binding as committed
 * on main, read from git (never a sandbox): the one check that needs the repo.
 */
import { withDefaultQueryLabels } from "../services/bigquery-labels";
import type {
  IAppProject,
  IDatabaseConnection,
} from "../database/workspace-schema";
import {
  bindingArtifactKey,
  buildResolvedBindingParquet,
  normalizeBindingText,
  readMainBinding,
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
import { getArtifactStore } from "../services/artifact-store.service";
import {
  draftHash,
  forgetDraftBuild,
  lookupDraft,
  recordDraftBuilt,
  recordDraftFailed,
} from "./binding-draft-cache";
import { reportBindingPhase } from "./binding-progress";
import { loggers } from "../logging";

const logger = loggers.api("apps");

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface DevBuildInput {
  project: IAppProject;
  name: string;
  /** Who asked: query labels and draft jobs. */
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
  /**
   * The app is not on main yet (unregistered-draft-app.ts): there is no
   * committed binding to serve or materialize, so every build is a draft.
   */
  unregistered?: boolean;
}

export type DevBuildResult =
  | {
      /**
       * A stored artifact answers as-is: the stored build of this exact
       * text ("committed"), or a recent draft build (binding-draft-cache.ts).
       */
      kind: "artifact";
      artifactKey: string;
      source: "committed" | "draft-cache";
    }
  | {
      /**
       * Built now from the caller's text; kept only as a short-lived draft,
       * never as the app's artifact.
       */
      kind: "draft";
      /** Local temp file; the caller streams it and deletes it. */
      filePath: string;
      /**
       * This draft's own per-build key in the draft cache, when it could be
       * kept.
       */
      artifactKey?: string;
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
  ) => Promise<{ binding: AppBinding; connection: IDatabaseConnection }>;
  /**
   * The committed binding on main in git (never a sandbox), or null when
   * main has none.
   */
  committedBinding: (
    project: IAppProject,
    name: string,
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
  committedBinding: readMainBinding,
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
  artifactExists: key => getArtifactStore().exists(key),
  build: buildResolvedBindingParquet,
  drafts: {
    lookup: lookupDraft,
    built: recordDraftBuilt,
    failed: recordDraftFailed,
    forget: forgetDraftBuild,
  },
};

/**
 * What a dev build will do, decided without running a query: answer from a
 * stored artifact, or build (`run`). Everything that can be refused (bad
 * input, no access, a draft cooling down after failures) is refused here, so
 * a caller that runs the build later — the async path (binding-jobs.ts) —
 * rejects the same requests up front.
 */
export type DevBuildPlan =
  | Extract<DevBuildResult, { kind: "artifact" }>
  | {
      kind: "build";
      run: () => Promise<Exclude<DevBuildResult, { kind: "artifact" }>>;
    };

export async function devBuildAppBinding(
  input: DevBuildInput,
  deps: DevBuildDeps = defaultDeps,
): Promise<DevBuildResult> {
  const plan = await planDevBuild(input, deps);
  return plan.kind === "build" ? plan.run() : plan;
}

export async function planDevBuild(
  input: DevBuildInput,
  deps: DevBuildDeps = defaultDeps,
): Promise<DevBuildPlan> {
  // Dev builds and their defer listings are tagged as such in BigQuery; the
  // returned run() may execute later (a binding job), so it re-enters.
  const labels = { mako_trigger: "dev", mako_user: input.actorId };
  const plan = await withDefaultQueryLabels(labels, () =>
    planDevBuildUnlabelled(input, deps),
  );
  if (plan.kind !== "build") return plan;
  return {
    kind: "build",
    run: () => withDefaultQueryLabels(labels, plan.run),
  };
}

async function planDevBuildUnlabelled(
  input: DevBuildInput,
  deps: DevBuildDeps,
): Promise<DevBuildPlan> {
  const { project, name } = input;
  if (!NAME_RE.test(name)) {
    throw new DevBuildError("Invalid binding name", 400);
  }
  reportBindingPhase("checking");

  let draft: { binding: AppBinding; connection: IDatabaseConnection };
  let rendered: { code: string; devModifiedAt?: number | null };
  let asPublished: boolean;
  try {
    // A CRLF checkout of the committed file is the committed file.
    draft = await deps.resolveDraft(
      project,
      name,
      normalizeBindingText(input.source),
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

  // The stored artifact for this text is content-addressed (connection,
  // database, query): its key comes from the text alone, so no repo and no
  // sandbox is read to find it. Only a parquet binding rendered as published
  // (prod dbt schema) can match a stored build; a dev dbt environment or a
  // live binding is always a draft, and so is every binding of an app not on
  // main yet.
  const storedKey =
    asPublished &&
    !input.unregistered &&
    draft.binding.materialization === "parquet"
      ? bindingArtifactKey(draft.binding)
      : null;

  if (input.canWrite) {
    // A writer may build any text, so serving the stored build of exactly
    // this text gives them nothing they could not run themselves. Nothing
    // here reads git or a sandbox: the laptop's text is the whole input.
    if (storedKey && !input.refresh && (await deps.artifactExists(storedKey))) {
      return { kind: "artifact", artifactKey: storedKey, source: "committed" };
    }
  } else {
    // A read-only caller may only read what main publishes. That is the one
    // check that needs the repo, and it reads main in git, never a sandbox.
    // Committed = the whole definition matches (connection, database, dbt
    // link, materialization, row limit, query), not just the artifact key.
    const committed = storedKey
      ? await deps.committedBinding(project, name)
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
      return {
        kind: "artifact",
        artifactKey: committedKey,
        source: "committed",
      };
    }
    throw new DevBuildError(
      input.unregistered
        ? `This app is not on main yet; building its bindings/${name}.sql needs member (not viewer) access to the workspace`
        : isCommitted
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
    rowLimit: draft.binding.rowLimit,
  });
  if (!input.refresh) {
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

  return { kind: "build", run: () => runDevBuild() };

  async function runDevBuild(): Promise<
    Exclude<DevBuildResult, { kind: "artifact" }>
  > {
    try {
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
      let keptKey: string | undefined;
      reportBindingPhase("uploading", {
        rowsWritten: built.rowCount,
        bytes: built.byteSize,
      });
      try {
        keptKey = await deps.drafts.built({ projectId, name, hash, ...built });
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
      return {
        kind: "draft",
        ...built,
        artifactKey: keptKey,
        builtAt: new Date(),
      };
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
}
