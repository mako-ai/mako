/**
 * Renames and old links (api/src/rename: `GET /objects/resolve`,
 * `POST /objects/{kind}/rename`).
 *
 * When a deep link names something the app does not know under that name,
 * the server says what the name points at now. `via: "alias"` means the
 * object was renamed: open it and show its new address, so the next copy of
 * the link is the current one.
 */
import { ApiError, api, unwrapBody, type operations } from "../api";

export type ObjectKind =
  operations["post_api_workspaces_workspaceId_objects_kind_rename"]["parameters"]["path"]["kind"];

export interface ObjectLocation {
  title?: string;
  slug?: string;
  path?: string;
  /** In-app path, e.g. `/apps/revenue`. */
  url?: string;
}

export interface ResolvedObjectRef {
  kind: ObjectKind;
  id: string;
  via: "current" | "alias";
  current: ObjectLocation;
}

export interface RenameObjectResult {
  kind: ObjectKind;
  id: string;
  before: ObjectLocation;
  after: ObjectLocation;
  aliasesAdded: string[];
  commit?: string;
  warnings: string[];
}

/**
 * What `ref` points at now, or `null` when the server says nothing (or more
 * than one object) answers to it — a 404. Any other failure (network, 5xx,
 * 403) is THROWN: "could not find out" is not "gone", and a caller that
 * shows a dead-link notice must do so only on a real not-found.
 */
export async function resolveObjectRef(
  workspaceId: string,
  kind: ObjectKind,
  ref: string,
): Promise<ResolvedObjectRef | null> {
  try {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/objects/resolve", {
        params: { path: { workspaceId }, query: { kind, ref } },
      }),
    ) as { resolved?: ResolvedObjectRef };
    return body.resolved ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Rename an object. Throws with the server's own words on a refusal. */
export async function renameObject(
  workspaceId: string,
  kind: ObjectKind,
  request: { ref: string; title?: string; slug?: string },
): Promise<RenameObjectResult> {
  const body = unwrapBody(
    await api.POST("/api/workspaces/{workspaceId}/objects/{kind}/rename", {
      params: { path: { workspaceId, kind } },
      body: request,
    }),
  ) as { result?: RenameObjectResult };
  if (!body.result) throw new Error("The rename did not complete.");
  return body.result;
}
