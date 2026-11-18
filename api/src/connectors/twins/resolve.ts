/**
 * Which folder a built-in-typed connection runs: its registry twin.
 *
 * 1. The workspace's own `connectors/<type>/` when it has one. That is the
 *    folder the boxed switch moved its flows onto (a copied folder, or
 *    `source: mako/<type>@1`), so a connection keeps running the code its
 *    switched flows already run.
 * 2. Otherwise Mako's registry connector `mako/<type>@1`, resolved from the
 *    catalog. Its `spec` runs once per bundle hash per process: a published
 *    bundle is immutable, so the cached spec can never go stale.
 */
import { blobOid } from "../../apps/repository.service";
import { ConnectorDefinition } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { connectorRegistryEnabled } from "../workspace/registry/flag";
import {
  getRegistryCatalog,
  resolveReference,
  type RegistryResolution,
} from "../workspace/registry/registry.service";
import { parseRegistryReference } from "../workspace/registry/semver";
import type { RegistryCatalog } from "../workspace/registry/store";
import {
  DEFAULT_ENTRY,
  loadConnectorDefinition,
  type LoadedConnector,
} from "../workspace/resolver";
import { BUILTIN_TWIN_RANGE, type BuiltinTwinType } from "./types";

const logger = loggers.connector();

type SpecRunner = (
  workspaceId: string,
  resolution: RegistryResolution,
) => Promise<
  { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string }
>;

/** What resolution reads. Tests pass fakes; production uses the defaults. */
export interface TwinResolverDeps {
  hasWorkspaceFolder(workspaceId: string, slug: string): Promise<boolean>;
  loadWorkspaceFolder(
    workspaceId: string,
    slug: string,
  ): Promise<LoadedConnector>;
  registryEnabled(): boolean;
  catalog(): Promise<RegistryCatalog>;
  runSpec: SpecRunner;
}

const defaultDeps: TwinResolverDeps = {
  hasWorkspaceFolder: async (workspaceId, slug) =>
    Boolean(await ConnectorDefinition.exists({ workspaceId, slug })),
  loadWorkspaceFolder: loadConnectorDefinition,
  registryEnabled: connectorRegistryEnabled,
  catalog: () => getRegistryCatalog(),
  runSpec: async (workspaceId, resolution) => {
    // Lazy: the reconcile service pulls in the repo and sandbox machinery.
    const { runRegistrySpec } = await import("../workspace/reconcile.service");
    return runRegistrySpec(workspaceId, resolution);
  },
};

/** Specs by registry bundle hash. A bundle never changes under its hash. */
const specByHash = new Map<string, Promise<Record<string, unknown>>>();

/** Tests only: forget cached specs. */
export function clearTwinSpecCache(): void {
  specByHash.clear();
}

function registrySpec(
  deps: TwinResolverDeps,
  workspaceId: string,
  resolution: RegistryResolution,
): Promise<Record<string, unknown>> {
  const cached = specByHash.get(resolution.hash);
  if (cached) return cached;
  const pending = deps.runSpec(workspaceId, resolution).then(result => {
    if (!result.ok) {
      throw new Error(
        `mako/${resolution.slug}@${resolution.version} failed its spec: ${result.reason}`,
      );
    }
    return result.spec;
  });
  specByHash.set(resolution.hash, pending);
  // A failed run is not cached: the next caller tries again.
  pending.catch(() => specByHash.delete(resolution.hash));
  return pending;
}

/** The LoadedConnector a twin runs, from the workspace or the registry. */
export async function loadTwinDefinition(
  workspaceId: string,
  type: BuiltinTwinType,
  deps: TwinResolverDeps = defaultDeps,
): Promise<LoadedConnector> {
  if (await deps.hasWorkspaceFolder(workspaceId, type)) {
    return deps.loadWorkspaceFolder(workspaceId, type);
  }

  if (!deps.registryEnabled()) {
    throw new Error(
      `The "${type}" connector now runs from the connector registry (mako/${type}), ` +
        `and the registry is off on this Mako (CONNECTOR_REGISTRY_ENABLED).`,
    );
  }
  const reference = parseRegistryReference(
    `mako/${type}@${BUILTIN_TWIN_RANGE}`,
  );
  if (!reference.ok) throw new Error(reference.reason);
  const resolved = resolveReference(reference.value, await deps.catalog());
  if (!resolved.ok) throw new Error(resolved.reason);
  const { resolution } = resolved;

  const spec = await registrySpec(deps, workspaceId, resolution);
  const entities = Object.keys(
    ((spec.mako as { entities?: Record<string, unknown> } | undefined)
      ?.entities ?? {}) as Record<string, unknown>,
  );
  logger.debug("Resolved a built-in twin from the registry", {
    workspaceId,
    type,
    version: resolution.version,
  });
  return {
    slug: type,
    runtime: "node",
    entry: DEFAULT_ENTRY,
    // No workspace commit: the code is the registry bundle.
    sha: `registry:${resolution.hash}`,
    sourceSha: blobOid(
      `builtin-twin\nregistry:${resolution.slug}@${resolution.version}:${resolution.hash}`,
    ),
    spec,
    entities,
    status: "indexed",
    registry: {
      ref: resolution.ref,
      slug: resolution.slug,
      version: resolution.version,
      hash: resolution.hash,
      sha256: resolution.sha256,
    },
  };
}
