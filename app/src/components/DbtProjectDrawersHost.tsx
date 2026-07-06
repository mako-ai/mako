/**
 * App-root host for dbt project drawers — outside the explorer column
 * (overflow:hidden) and above the IDE.
 */
import { useEffect, useMemo } from "react";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore } from "../store/dbtStore";
import { useSchemaStore } from "../store/schemaStore";
import DbtProjectCreateDrawer from "./DbtProjectCreateDrawer";
import DbtProjectSettingsDrawer from "./DbtProjectSettingsDrawer";

const DBT_COMPATIBLE_TYPES = new Set([
  "postgresql",
  "bigquery",
  "clickhouse",
  "mysql",
  "redshift",
  "sqlserver",
  "snowflake",
]);

export default function DbtProjectDrawersHost() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const settingsProjectId = useDbtStore(s => s.settingsProjectId);
  const createProjectOpen = useDbtStore(s => s.createProjectOpen);
  const createProjectMode = useDbtStore(s => s.createProjectMode);
  const closeProjectSettings = useDbtStore(s => s.closeProjectSettings);
  const closeCreateProject = useDbtStore(s => s.closeCreateProject);
  const connectionsByWorkspace = useSchemaStore(s => s.connections);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);

  const drawerOpen = Boolean(settingsProjectId) || createProjectOpen;

  useEffect(() => {
    if (drawerOpen && workspaceId) {
      void ensureConnections(workspaceId);
    }
  }, [drawerOpen, workspaceId, ensureConnections]);

  const dbtConnections = useMemo(() => {
    const all = workspaceId ? (connectionsByWorkspace[workspaceId] ?? []) : [];
    return all.filter(conn => DBT_COMPATIBLE_TYPES.has(conn.type));
  }, [workspaceId, connectionsByWorkspace]);

  if (!workspaceId) return null;

  return (
    <>
      <DbtProjectSettingsDrawer
        open={Boolean(settingsProjectId)}
        projectId={settingsProjectId}
        workspaceId={workspaceId}
        connections={dbtConnections}
        onClose={closeProjectSettings}
      />
      <DbtProjectCreateDrawer
        open={createProjectOpen}
        mode={createProjectMode}
        workspaceId={workspaceId}
        connections={dbtConnections}
        onClose={closeCreateProject}
      />
    </>
  );
}
