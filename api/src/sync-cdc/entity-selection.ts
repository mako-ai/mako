import type { IFlow } from "../database/workspace-schema";

type FlowEntitySelectionSource =
  Pick<IFlow, "entityFilter" | "entityLayouts"> | null | undefined;

function normalizeEntityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueEntities(entities: string[]): string[] {
  return Array.from(new Set(entities));
}

export function resolveConfiguredEntities(flow: FlowEntitySelectionSource): {
  entities: string[];
  hasExplicitSelection: boolean;
} {
  const hasEntityLayouts =
    Array.isArray(flow?.entityLayouts) && flow.entityLayouts.length > 0;

  if (hasEntityLayouts) {
    const entities = (flow?.entityLayouts || [])
      .filter(
        (layout: any) =>
          layout &&
          layout.enabled !== false &&
          normalizeEntityName(layout.entity) !== null,
      )
      .map((layout: any) => normalizeEntityName(layout.entity))
      .filter((entity): entity is string => entity !== null);

    return {
      entities: uniqueEntities(entities),
      hasExplicitSelection: true,
    };
  }

  const hasEntityFilter =
    Array.isArray(flow?.entityFilter) && flow.entityFilter.length > 0;
  if (hasEntityFilter) {
    const entities = (flow?.entityFilter || [])
      .map(entity => normalizeEntityName(entity))
      .filter((entity): entity is string => entity !== null);

    return {
      entities: uniqueEntities(entities),
      hasExplicitSelection: true,
    };
  }

  return {
    entities: [],
    hasExplicitSelection: false,
  };
}

export function isEntityEnabledForFlow(
  flow: FlowEntitySelectionSource,
  ...entityCandidates: Array<string | undefined | null>
): boolean {
  const { entities, hasExplicitSelection } = resolveConfiguredEntities(flow);
  if (!hasExplicitSelection) return true;

  const selected = new Set(entities);
  const normalizedCandidates = entityCandidates
    .map(entity => normalizeEntityName(entity))
    .filter((entity): entity is string => entity !== null);

  if (normalizedCandidates.length === 0) return false;
  return normalizedCandidates.some(entity => selected.has(entity));
}

/**
 * Sorted, comma-joined enabled entities: a cheap equality key for "did this
 * edit change which entities the flow syncs?".
 */
export function flowEntitySignature(flow: FlowEntitySelectionSource): string {
  return [...resolveConfiguredEntities(flow).entities].sort().join(",");
}

/**
 * A requested entity list (backfill scope, resync subset): the trimmed,
 * non-empty strings, de-duplicated in order. Anything not an array is none.
 */
export function normalizeEntityList(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  return Array.from(
    new Set(
      entities
        .filter(
          (entity): entity is string =>
            typeof entity === "string" && entity.trim().length > 0,
        )
        .map(entity => entity.trim()),
    ),
  );
}
