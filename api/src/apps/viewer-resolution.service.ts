/**
 * Who the viewer is under an app's `viewers` config — the one place that
 * joins the pure resolution (viewers.service) to the repo and the artifact
 * store, for a config whose roles come from a `source` binding (apps.md
 * §27). Used by published serving and by the builder preview routes, so
 * `?as=<email>` on a laptop shows exactly what the published app will do.
 */
import type { IAppProject } from "../database/workspace-schema";
import type { DashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { bindingArtifactKey, readBinding } from "./bindings.service";
import { lookupViewerRowInArtifact } from "./filtered-parquet.service";
import {
  resolveViewer,
  type ResolvedViewer,
  type ViewerIdentity,
  type ViewersConfig,
} from "./viewers.service";

/** The config cannot be applied — the app must refuse, with this message. */
export class ViewerSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerSourceError";
  }
}

export async function resolveViewerFor(input: {
  project: IAppProject;
  /** Whose view of the repo (builder preview), or "" at a published commit. */
  actorId: string;
  /** The published commit; absent = the actor's working view. */
  at?: string;
  config: ViewersConfig;
  viewer: ViewerIdentity;
  /** Where the source artifact may be read from; null = nowhere (never built). */
  storeFor: (key: string) => Promise<DashboardArtifactStore | null>;
}): Promise<ResolvedViewer | null> {
  const { config } = input;
  if (!config.source) return resolveViewer(config, input.viewer);

  const binding = await readBinding(
    input.project,
    config.source,
    input.actorId,
    input.at,
  );
  if (!binding) {
    throw new ViewerSourceError(
      `mako.json names viewers source "${config.source}", but bindings/${config.source}.sql does not exist`,
    );
  }
  const key = bindingArtifactKey(binding);
  const store = await input.storeFor(key);
  let found: Awaited<ReturnType<typeof lookupViewerRowInArtifact>> = null;
  if (store) {
    try {
      found = await lookupViewerRowInArtifact(store, key, input.viewer.email);
    } catch (error) {
      throw new ViewerSourceError(
        `viewers source "${config.source}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!found) {
    throw new ViewerSourceError(
      `viewers source "${config.source}" has not been materialized yet — roles cannot be resolved until it is`,
    );
  }
  try {
    return resolveViewer(config, input.viewer, found.row);
  } catch (error) {
    throw new ViewerSourceError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
