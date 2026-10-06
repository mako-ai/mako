/**
 * Old links to renamed objects (api/src/rename, `GET /objects/resolve`).
 *
 * When a deep link names something that no longer exists under that name,
 * ask the server what the name points at now. `via: "alias"` means the
 * object was renamed: open it at `current.url` and replace the address bar,
 * so the next copy of the link is the new one.
 */
import { apiClient } from "./api-client";

export type ObjectKind =
  | "app"
  | "console"
  | "notebook"
  | "dashboard"
  | "flow"
  | "dbt_file"
  | "dbt_job"
  | "skill"
  | "connector"
  | "connection";

export interface ObjectLocation {
  title?: string;
  slug?: string;
  path?: string;
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

/** `null` when nothing (or more than one object) answers to `ref`. */
export async function resolveObjectRef(
  workspaceId: string,
  kind: ObjectKind,
  ref: string,
): Promise<ResolvedObjectRef | null> {
  try {
    const response = await apiClient.get<{
      success: boolean;
      resolved?: ResolvedObjectRef;
    }>(`/workspaces/${workspaceId}/objects/resolve`, { kind, ref });
    return response.success && response.resolved ? response.resolved : null;
  } catch {
    return null;
  }
}

/** Throws with the server's message on failure. */
export async function renameObject(
  workspaceId: string,
  kind: ObjectKind,
  request: {
    ref: string;
    title?: string;
    slug?: string;
    options?: Record<string, unknown>;
  },
): Promise<RenameObjectResult> {
  const response = await apiClient.post<{
    success: boolean;
    result?: RenameObjectResult;
    error?: string;
  }>(`/workspaces/${workspaceId}/objects/${kind}/rename`, request);
  if (!response.success || !response.result) {
    throw new Error(response.error ?? "Rename failed");
  }
  return response.result;
}
