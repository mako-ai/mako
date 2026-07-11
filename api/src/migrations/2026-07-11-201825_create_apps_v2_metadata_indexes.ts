import { Db, type CreateIndexesOptions } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create Apps v2 metadata collections and indexes without touching Apps v1";

interface IndexDefinition {
  keys: Record<string, 1 | -1>;
  options?: Pick<
    CreateIndexesOptions,
    "unique" | "sparse" | "partialFilterExpression" | "collation" | "name"
  >;
}

export const appsV2IndexesByCollection: Record<string, IndexDefinition[]> = {
  app_v2_projects: [
    { keys: { workspaceId: 1, updatedAt: -1 } },
    { keys: { workspaceId: 1, deletionStatus: 1, updatedAt: -1 } },
    { keys: { workspaceId: 1, owner_id: 1 } },
    { keys: { workspaceId: 1, "sharedWith.userId": 1 } },
    { keys: { repositoryId: 1 }, options: { unique: true } },
  ],
  app_v2_worktrees: [
    {
      keys: { projectId: 1, actorId: 1 },
      options: { unique: true },
    },
    { keys: { workspaceId: 1, projectId: 1 } },
    { keys: { wipRef: 1 }, options: { unique: true } },
    { keys: { leaseRef: 1 }, options: { unique: true } },
  ],
  app_v2_commits: [
    { keys: { projectId: 1, sha: 1 }, options: { unique: true } },
    { keys: { workspaceId: 1, projectId: 1, authoredAt: -1 } },
  ],
};

interface ExistingIndex {
  key?: unknown;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
  name?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function normalizeCollation(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const { version: _version, ...specified } = value as Record<string, unknown>;
  return canonicalize({
    caseLevel: false,
    caseFirst: "off",
    strength: 3,
    numericOrdering: false,
    alternate: "non-ignorable",
    maxVariable: "punct",
    normalization: false,
    backwards: false,
    ...specified,
  });
}

function semanticOptionSnapshot(index: ExistingIndex): Record<string, unknown> {
  return {
    unique: index.unique === true,
    sparse: index.sparse === true,
    partialFilterExpression: canonicalize(index.partialFilterExpression),
    collation: normalizeCollation(index.collation),
  };
}

export function findCompatibleIndex(
  indexes: ExistingIndex[],
  keys: Record<string, 1 | -1>,
  options: IndexDefinition["options"],
  collectionName: string,
): ExistingIndex | undefined {
  const target = JSON.stringify(keys);
  const existing = indexes.find(index => JSON.stringify(index.key) === target);
  if (!existing) return undefined;
  const expectedOptions = semanticOptionSnapshot(options ?? {});
  const actualOptions = semanticOptionSnapshot(existing);
  if (JSON.stringify(expectedOptions) !== JSON.stringify(actualOptions)) {
    throw new Error(
      `Apps v2 index option mismatch on ${collectionName} for ${target}: expected ${JSON.stringify(expectedOptions)}, found ${JSON.stringify(actualOptions)}`,
    );
  }
  return existing;
}

export async function up(db: Db): Promise<void> {
  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      collection => collection.name,
    ),
  );

  for (const [collectionName, definitions] of Object.entries(
    appsV2IndexesByCollection,
  )) {
    if (!existingCollections.has(collectionName)) {
      await db.createCollection(collectionName);
    }
    const collection = db.collection(collectionName);
    let indexes = await collection.listIndexes().toArray();
    for (const definition of definitions) {
      if (
        findCompatibleIndex(
          indexes,
          definition.keys,
          definition.options,
          collectionName,
        )
      ) {
        continue;
      }
      await collection.createIndex(definition.keys, definition.options);
      indexes = await collection.listIndexes().toArray();
    }
    log.info("Ensured Apps v2 metadata indexes", { collectionName });
  }
}
