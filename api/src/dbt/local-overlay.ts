/**
 * A laptop's dbt/ folder, as a run input (`mako dbt run`).
 *
 * The server cannot see a developer's checkout, and committing it somewhere
 * so a run could read it would put half-finished work on a branch. So the
 * CLI sends what differs from a commit the server has (`baseSha`: where the
 * checkout forked from main) — or, without one, the whole dbt/ tree — and
 * the run builds that commit's tree with those files laid over it. Nothing
 * is committed and no branch moves: the overlay is a content-addressed blob
 * the run reads once.
 *
 * Paths are PROJECT-relative (`models/foo.sql`), like every dbt file API.
 */
import crypto from "node:crypto";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

export interface LocalOverlay {
  /** Commit of the workspace repo the files are relative to; absent = whole tree. */
  baseSha?: string;
  /** Files added or changed relative to the base, full text. */
  files: Record<string, string>;
  /** Files present at the base that the checkout deleted. */
  deletes: string[];
}

/** Same per-file cap the working tree loader applies to committed files. */
export const LOCAL_OVERLAY_MAX_FILE_BYTES = 1_000_000;
/** A whole RealAdvisor-sized dbt/ tree is ~4 MB of text; leave headroom. */
export const LOCAL_OVERLAY_MAX_TOTAL_BYTES = 16_000_000;
export const LOCAL_OVERLAY_MAX_FILES = 5_000;

export class LocalOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOverlayError";
  }
}

function assertSafeProjectPath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some(seg => seg === ".." || seg === "" || seg === ".git")
  ) {
    throw new LocalOverlayError(`Unsafe dbt path: ${String(path)}`);
  }
  return path;
}

/** Validate a request body's overlay. Throws LocalOverlayError on bad input. */
export function normalizeLocalOverlay(input: {
  baseSha?: unknown;
  files?: unknown;
  deletes?: unknown;
}): LocalOverlay {
  const baseSha =
    input.baseSha === undefined || input.baseSha === null
      ? undefined
      : String(input.baseSha);
  if (baseSha !== undefined && !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new LocalOverlayError("baseSha must be a full 40-character commit");
  }
  const rawFiles = input.files ?? {};
  if (typeof rawFiles !== "object" || Array.isArray(rawFiles)) {
    throw new LocalOverlayError("files must be an object of path → content");
  }
  const rawDeletes = input.deletes ?? [];
  if (!Array.isArray(rawDeletes)) {
    throw new LocalOverlayError("deletes must be an array of paths");
  }
  const entries = Object.entries(rawFiles as Record<string, unknown>);
  if (entries.length + rawDeletes.length > LOCAL_OVERLAY_MAX_FILES) {
    throw new LocalOverlayError(
      `Too many files (${entries.length + rawDeletes.length}); the limit is ${LOCAL_OVERLAY_MAX_FILES}`,
    );
  }
  const files: Record<string, string> = {};
  let total = 0;
  for (const [path, content] of entries) {
    assertSafeProjectPath(path);
    if (typeof content !== "string") {
      throw new LocalOverlayError(`Content of ${path} must be text`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > LOCAL_OVERLAY_MAX_FILE_BYTES) {
      throw new LocalOverlayError(
        `${path} is ${bytes} bytes; the per-file limit is ${LOCAL_OVERLAY_MAX_FILE_BYTES}`,
      );
    }
    total += bytes;
    files[path] = content;
  }
  if (total > LOCAL_OVERLAY_MAX_TOTAL_BYTES) {
    throw new LocalOverlayError(
      `The upload is ${total} bytes; the limit is ${LOCAL_OVERLAY_MAX_TOTAL_BYTES}`,
    );
  }
  const deletes = [...new Set(rawDeletes.map(p => assertSafeProjectPath(p)))];
  if (!baseSha && deletes.length > 0) {
    throw new LocalOverlayError("deletes need a baseSha to delete from");
  }
  if (!baseSha && !("dbt_project.yml" in files)) {
    throw new LocalOverlayError(
      "Without a baseSha the upload must be the whole dbt/ tree (dbt_project.yml is missing)",
    );
  }
  return { ...(baseSha ? { baseSha } : {}), files, deletes };
}

/** The base tree with the overlay laid over it, sorted like the loader's. */
export function applyLocalOverlay(
  base: ReadonlyArray<{ path: string; content: string }>,
  overlay: Pick<LocalOverlay, "files" | "deletes">,
): Array<{ path: string; content: string }> {
  const merged = new Map(base.map(f => [f.path, f.content]));
  for (const path of overlay.deletes) merged.delete(path);
  for (const [path, content] of Object.entries(overlay.files)) {
    merged.set(path, content);
  }
  return [...merged.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function overlayKey(workspaceId: string, body: Buffer): string {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  return `dbt-local-overlays/${workspaceId}/${digest}.json`;
}

/** Store an overlay (content-addressed: an identical re-run writes nothing). */
export async function storeLocalOverlay(
  workspaceId: string,
  overlay: LocalOverlay,
): Promise<string> {
  const body = Buffer.from(JSON.stringify(overlay), "utf8");
  const key = overlayKey(workspaceId, body);
  const store = getDashboardArtifactStore();
  if (!(await store.exists(key))) {
    await store.putBuffer(body, key, "application/json", { workspaceId });
  }
  return key;
}

export async function loadLocalOverlay(key: string): Promise<LocalOverlay> {
  const stream = await getDashboardArtifactStore().openReadStream(key);
  if (!stream) {
    throw new Error(
      "The uploaded dbt files for this run are gone; run `mako dbt run` again",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    baseSha?: string;
    files?: Record<string, string>;
    deletes?: string[];
  };
  return {
    ...(parsed.baseSha ? { baseSha: parsed.baseSha } : {}),
    files: parsed.files ?? {},
    deletes: parsed.deletes ?? [],
  };
}
