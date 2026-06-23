import { useMemo } from "react";

interface DbTypeLike {
  type: string;
  iconUrl?: string | null;
}

interface ConnectionLike {
  id: string;
  type: string;
}

/**
 * Build a `connectionId -> iconUrl` map by joining the database-type catalog
 * (which carries icons per type) with the workspace's connections. Shared by
 * `Chat` and `Editor`, which previously duplicated this `useMemo` verbatim.
 */
export function useConnectionIconMap(
  dbTypes: DbTypeLike[] | null | undefined,
  connections: ConnectionLike[],
): Map<string, string> {
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
