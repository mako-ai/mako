/**
 * Which apps read a model: the table references in app bindings (the apps
 * index extracts them, app-search.ts `extractTables`) mapped back to dbt
 * nodes through each node's warehouse relation. Pure: no I/O.
 *
 * A binding names a table in one of three ways:
 *
 * - `{{ dbt_schema }}.fct_orders` (optionally project-qualified): a dbt
 *   model, whatever schema the environment renders;
 * - `project.dataset.table`, quoted or not: a full relation;
 * - `dataset.table`: a relation without its project.
 *
 * A bare `table` says too little to attribute and is never matched to a
 * node.
 */
import type { AppIndexRow } from "../../apps/app-index.service";
import {
  normalizeRelation,
  type IndexedNode,
  type ManifestIndex,
} from "./manifest-index";

const DBT_SCHEMA = "{{dbt_schema}}";

/** One app's bindings and the tables each reads. */
export interface AppBindingReads {
  appId: string;
  path: string;
  title: string;
  bindings: Array<{ binding: string; tables: string[] }>;
}

/** The reads of an index row; apps indexed before per-binding tables: none. */
export function bindingReadsOf(
  app: Pick<AppIndexRow, "appId" | "path" | "title" | "bindingTables">,
): AppBindingReads {
  return {
    appId: app.appId,
    path: app.path,
    title: app.title,
    bindings: app.bindingTables ?? [],
  };
}

/** Does a binding's table reference name this node's relation? */
export function referenceReadsNode(
  reference: string,
  node: Pick<IndexedNode, "resourceType" | "relationKey" | "relationTable">,
): boolean {
  const ref = normalizeRelation(reference);
  const parts = ref.split(".");
  if (parts.length < 2) return false;
  if (parts.includes(DBT_SCHEMA)) {
    // The templated schema is a dbt target schema: never a source's.
    return (
      node.resourceType !== "source" &&
      parts[parts.length - 1] === node.relationTable
    );
  }
  if (!node.relationKey) return false;
  return (
    node.relationKey === ref ||
    node.relationKey.endsWith(`.${ref}`) ||
    ref.endsWith(`.${node.relationKey}`)
  );
}

/**
 * Does a reference name this raw table? For tables no dbt node describes:
 * the caller's `dataset.table` matches a binding's `project.dataset.table`
 * and the reverse.
 */
export function referenceReadsRelation(
  reference: string,
  relation: string,
): boolean {
  const ref = normalizeRelation(reference);
  const target = normalizeRelation(relation);
  if (!ref || !target) return false;
  if (ref === target) return true;
  if (target.includes(".") && ref.endsWith(`.${target}`)) return true;
  return ref.includes(".") && target.endsWith(`.${ref}`);
}

export interface ModelReader {
  appId: string;
  path: string;
  title: string;
  /** Binding files, repo-relative: `apps/x/bindings/orders.sql`. */
  bindings: string[];
}

function readersWhere(
  apps: readonly AppBindingReads[],
  reads: (reference: string) => boolean,
): ModelReader[] {
  const out: ModelReader[] = [];
  for (const app of apps) {
    const bindings = app.bindings
      .filter(binding => binding.tables.some(reads))
      .map(binding => `${app.path}/bindings/${binding.binding}.sql`)
      .sort();
    if (bindings.length === 0) continue;
    out.push({ appId: app.appId, path: app.path, title: app.title, bindings });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The apps (and binding files) that read a dbt node. */
export function readersOfNode(
  apps: readonly AppBindingReads[],
  node: Pick<IndexedNode, "resourceType" | "relationKey" | "relationTable">,
): ModelReader[] {
  return readersWhere(apps, reference => referenceReadsNode(reference, node));
}

/** The apps (and binding files) that read a table no dbt node describes. */
export function readersOfRelation(
  apps: readonly AppBindingReads[],
  relation: string,
): ModelReader[] {
  return readersWhere(apps, reference =>
    referenceReadsRelation(reference, relation),
  );
}

/**
 * How many apps read each node, by node id: one pass over every binding
 * reference instead of one scan per node (find_models scores hundreds).
 */
export function readerCountsByNode(
  index: ManifestIndex,
  apps: readonly AppBindingReads[],
): Map<string, number> {
  const byRelation = new Map<string, IndexedNode[]>();
  const byTable = new Map<string, IndexedNode[]>();
  const push = (
    map: Map<string, IndexedNode[]>,
    key: string,
    n: IndexedNode,
  ) => {
    const list = map.get(key);
    if (list) list.push(n);
    else map.set(key, [n]);
  };
  for (const node of index.nodes) {
    if (node.resourceType !== "source") push(byTable, node.relationTable, node);
    if (!node.relationKey) continue;
    // Every dotted suffix: `p.d.t` answers to `p.d.t` and `d.t`.
    const parts = node.relationKey.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      push(byRelation, parts.slice(i).join("."), node);
    }
  }
  const readers = new Map<string, Set<string>>();
  for (const app of apps) {
    for (const binding of app.bindings) {
      for (const reference of binding.tables) {
        const ref = normalizeRelation(reference);
        const parts = ref.split(".");
        if (parts.length < 2) continue;
        const candidates = parts.includes(DBT_SCHEMA)
          ? (byTable.get(parts[parts.length - 1]) ?? [])
          : [
              ...(byRelation.get(ref) ?? []),
              // A reference longer than the relation dbt recorded.
              ...(parts.length > 2
                ? (byRelation.get(parts.slice(1).join(".")) ?? [])
                : []),
            ];
        for (const node of candidates) {
          if (!referenceReadsNode(ref, node)) continue;
          let set = readers.get(node.id);
          if (!set) readers.set(node.id, (set = new Set()));
          set.add(app.path);
        }
      }
    }
  }
  return new Map([...readers].map(([id, set]) => [id, set.size]));
}
