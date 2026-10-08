/**
 * What the UI needs to know about a workspace's connectors.
 *
 * Kept apart from the resolver because these answers are for humans picking a
 * connector, not for the engine running one: they must be cheap, they must
 * never boot a sandbox, and they must be honest about a connector that is not
 * usable yet rather than hiding it.
 */
import {
  findConnectorDefinitionRow,
  listConnectorDefinitions,
  loadConnectorDefinition,
} from "./resolver";
import {
  connectionSpecificationToForm,
  type FormSchema,
} from "./spec-translation";
import { ConnectorDefinition } from "../../database/workspace-schema";
import {
  WORKSPACE_TYPE_PREFIX,
  slugFromType,
  isWorkspaceConnectorType,
} from "./SandboxedConnector";

export interface WorkspaceConnectorSummary {
  type: string;
  name: string;
  version: string;
  description: string;
  supportedEntities: string[];
  /** False while the connector is blocked, so the picker can grey it out. */
  usable: boolean;
  status: "indexed" | "verified" | "blocked";
  blockedReason?: string;
  /** Why the last connection test failed. A bad key, not a broken connector. */
  lastCheckError?: string;
  hasIcon: boolean;
  /** Previous slugs; connections typed `ws:<alias>` still resolve here. */
  aliases: string[];
  source: "workspace";
}

/** Every connector this workspace ships, for the catalog the picker renders. */
export async function listWorkspaceConnectors(
  workspaceId: string,
): Promise<WorkspaceConnectorSummary[]> {
  const rows = await ConnectorDefinition.find({ workspaceId })
    .sort({ slug: 1 })
    .lean();
  return rows.map(row => {
    const mako = (row.spec as any)?.mako ?? {};
    return {
      type: `${WORKSPACE_TYPE_PREFIX}${row.slug}`,
      name: mako.name ?? row.slug,
      version: mako.version ?? "0.0.0",
      description:
        row.status === "blocked"
          ? `Blocked: ${row.blockedReason ?? "this connector failed its last check"}`
          : `${row.slug} — from this workspace's repository`,
      supportedEntities: row.entities ?? [],
      usable: row.status !== "blocked",
      status: row.status,
      blockedReason: row.blockedReason,
      lastCheckError: row.lastCheckError,
      hasIcon: row.hasIcon === true,
      aliases: row.aliases ?? [],
      source: "workspace" as const,
    };
  });
}

/**
 * The credential form for one workspace connector.
 *
 * Derived from the spec captured at push time, so rendering a form is a Mongo
 * read: no sandbox, no git, nothing that could make opening a form slow or
 * make it fail when a box is cold.
 */
export async function workspaceConnectorForm(
  workspaceId: string,
  type: string,
): Promise<FormSchema> {
  const definition = await loadConnectorDefinition(
    workspaceId,
    slugFromType(type),
  );
  return connectionSpecificationToForm(
    (definition.spec as any)?.connectionSpecification,
  );
}

/**
 * May a data source be created with this type?
 *
 * The global registry deliberately cannot answer for `ws:` types, because the
 * answer depends on the workspace. A blocked connector is refused here rather
 * than at first sync: creating a data source against a connector that cannot
 * run produces a broken flow and a confusing failure much later.
 */
export async function connectorTypeExists(
  type: string,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isWorkspaceConnectorType(type)) return { ok: true };
  const slug = slugFromType(type);
  const found = await findConnectorDefinitionRow(workspaceId, slug);
  if (!found) {
    return {
      ok: false,
      reason: `This workspace has no connector "${slug}". Push a folder at connectors/${slug}/ to main.`,
    };
  }
  const row = found.row;
  if (row.status === "blocked") {
    return {
      ok: false,
      reason: `The connector "${row.slug}" is blocked: ${row.blockedReason ?? "it failed its last check"}`,
    };
  }
  return { ok: true };
}

/**
 * The type a connection should be STORED with: `ws:<current slug>`, even
 * when the caller named an alias. A connection typed `ws:<old>` would keep
 * working through the alias — until someone pushes a NEW connector at
 * `connectors/<old>/`, at which point the live name wins and that
 * connection's credentials would start going to the new connector's
 * sandbox. Canonicalizing at write time closes that door; the alias stays
 * only for connections that pre-date the rename, which the reconcile
 * migrates (and re-points if a live `<old>` ever appears).
 * Built-in types and unknown slugs come back unchanged.
 */
export async function canonicalConnectorType(
  type: string,
  workspaceId: string,
): Promise<string> {
  if (!isWorkspaceConnectorType(type)) return type;
  const found = await findConnectorDefinitionRow(
    workspaceId,
    slugFromType(type),
  );
  return found ? `${WORKSPACE_TYPE_PREFIX}${found.row.slug}` : type;
}

export { listConnectorDefinitions };
