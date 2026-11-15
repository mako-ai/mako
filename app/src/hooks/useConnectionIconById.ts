import { useEffect, useMemo } from "react";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";

/**
 * Connection id → database-type icon URL (from the database catalog), for
 * decorating console tabs and console tool cards. Loads the catalog once.
 */
export function useConnectionIconById(
  connections: ReadonlyArray<{ id: string; type: string }>,
): Map<string, string> {
  const dbTypes = useDatabaseCatalogStore(state => state.types);
  const fetchDbTypes = useDatabaseCatalogStore(state => state.fetchTypes);
  useEffect(() => {
    fetchDbTypes().catch(() => undefined);
  }, [fetchDbTypes]);

  return useMemo(() => {
    const iconByType = new Map<string, string>();
    for (const dbType of dbTypes ?? []) {
      if (dbType.iconUrl) iconByType.set(dbType.type, dbType.iconUrl);
    }
    const iconByConnectionId = new Map<string, string>();
    for (const connection of connections) {
      const iconUrl = iconByType.get(connection.type);
      if (iconUrl) iconByConnectionId.set(connection.id, iconUrl);
    }
    return iconByConnectionId;
  }, [dbTypes, connections]);
}
