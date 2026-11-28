/** Lineage: the flattened manifest parent_map for the DAG view. */
import { Hono } from "hono";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { dbtRepo } from "../../repositories/dbt";
import { getArtifactStore } from "../../services/artifact-store.service";
import { serverError, findProject } from "./context";
import { fail } from "../lib/respond";

export const dbtLineageRoutes = new Hono();

// ---------------------------------------------------------------------------
// Lineage — flattened manifest parent_map for the DAG view
// ---------------------------------------------------------------------------

interface ManifestColumn {
  name?: string;
  description?: string;
  data_type?: string | null;
}

interface ManifestNode {
  name?: string;
  resource_type?: string;
  original_file_path?: string;
  description?: string;
  columns?: Record<string, ManifestColumn>;
  tags?: string[];
  config?: { materialized?: string };
}

interface ManifestForLineage {
  nodes?: Record<string, ManifestNode>;
  sources?: Record<
    string,
    {
      name?: string;
      source_name?: string;
      resource_type?: string;
      description?: string;
      columns?: Record<string, ManifestColumn>;
    }
  >;
  exposures?: Record<
    string,
    {
      name?: string;
      label?: string;
      type?: string;
      url?: string;
      description?: string;
      maturity?: string;
      owner?: { name?: string; email?: string };
    }
  >;
  parent_map?: Record<string, string[]>;
}

function mapColumns(
  columns: Record<string, ManifestColumn> | undefined,
): Array<{ name: string; type?: string; description?: string }> {
  if (!columns) return [];
  return Object.values(columns).map(col => ({
    name: col.name ?? "",
    type: col.data_type ?? undefined,
    description: col.description || undefined,
  }));
}

dbtLineageRoutes.get(
  "/projects/:projectId/lineage",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      // Latest run with a manifest artifact wins.
      const run = await dbtRepo.findLatestArtifactRun(
        {
          workspaceId: project.workspaceId,
          projectId: project._id,
          hasManifest: true,
        },
        true,
      );
      if (!run?.artifactKeys?.manifest) {
        return c.json({
          success: true,
          lineage: { nodes: [], edges: [], generatedAt: null },
        });
      }
      const store = getArtifactStore();
      const stream = await store.openReadStream(run.artifactKeys.manifest);
      if (!stream) {
        return fail(c, 404, "Manifest not found");
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const manifest = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ManifestForLineage;

      const statusByUniqueId = new Map(
        (run.stepResults ?? []).map(step => [step.uniqueId, step.status]),
      );

      const includedTypes = new Set(["model", "seed", "snapshot", "source"]);
      const nodes: Array<{
        id: string;
        name: string;
        resourceType: string;
        filePath?: string;
        lastStatus?: string;
        description?: string;
        materialized?: string;
        tags?: string[];
        columns?: Array<{ name: string; type?: string; description?: string }>;
        url?: string;
        owner?: string;
      }> = [];

      for (const [id, node] of Object.entries(manifest.nodes ?? {})) {
        const resourceType = node.resource_type ?? id.split(".")[0];
        if (!includedTypes.has(resourceType)) continue;
        nodes.push({
          id,
          name: node.name ?? id,
          resourceType,
          filePath: node.original_file_path,
          lastStatus: statusByUniqueId.get(id),
          description: node.description || undefined,
          materialized: node.config?.materialized,
          tags: node.tags?.length ? node.tags : undefined,
          columns: mapColumns(node.columns),
        });
      }
      for (const [id, source] of Object.entries(manifest.sources ?? {})) {
        nodes.push({
          id,
          name: source.source_name
            ? `${source.source_name}.${source.name}`
            : (source.name ?? id),
          resourceType: "source",
          description: source.description || undefined,
          columns: mapColumns(source.columns),
        });
      }
      // Exposures are leaf consumers (dashboards/apps) — render them as
      // terminal nodes so the DAG shows what downstream depends on each model.
      for (const [id, exposure] of Object.entries(manifest.exposures ?? {})) {
        nodes.push({
          id,
          name: exposure.label || exposure.name || id,
          resourceType: "exposure",
          description: exposure.description || undefined,
          materialized: exposure.type,
          url: exposure.url,
          owner: exposure.owner?.name || exposure.owner?.email,
        });
      }

      const nodeIds = new Set(nodes.map(node => node.id));
      const edges: Array<{ source: string; target: string }> = [];
      for (const [child, parents] of Object.entries(
        manifest.parent_map ?? {},
      )) {
        if (!nodeIds.has(child)) continue;
        for (const parent of parents) {
          if (!nodeIds.has(parent)) continue;
          edges.push({ source: parent, target: child });
        }
      }

      return c.json({
        success: true,
        lineage: { nodes, edges, generatedAt: run.createdAt },
      });
    } catch (error) {
      return serverError(c, error, "Failed to build dbt lineage");
    }
  },
);
