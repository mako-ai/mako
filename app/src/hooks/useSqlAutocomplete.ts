import { useEffect, useMemo, useRef } from "react";
import { useSchemaStore } from "../store/schemaStore";
import {
  getDotContext,
  getFromOrJoinToken,
  parseTableContext,
  stripSqlIdentifierQuotes,
} from "../lib/sql-autocomplete/sqlContext";
import { SQL_KEYWORDS } from "../lib/sql-autocomplete/sqlKeywords";

type Monaco = unknown;

type UseSqlAutocompleteArgs = {
  monaco: Monaco | null;
  /** Getter for current workspace ID - called dynamically */
  getWorkspaceId: () => string | undefined;
  /** Getter for current connection ID - called dynamically */
  getConnectionId: () => string | undefined;
  /** Getter for current connection type - called dynamically */
  getConnectionType: () => string | undefined;
};

/**
 * Unified SQL autocomplete hook that registers a SINGLE global completion provider.
 * Dynamically fetches the active connection context on each completion request.
 * This prevents multiple providers from different Console tabs conflicting.
 */
export function useSqlAutocomplete({
  monaco,
  getWorkspaceId,
  getConnectionId,
  getConnectionType,
}: UseSqlAutocompleteArgs) {
  const completionProviderRef = useRef<{ dispose: () => void } | null>(null);

  // Store methods for lazy loading (BigQuery-style)
  const ensureTreeRoot = useSchemaStore(s => s.ensureTreeRoot);
  const ensureTreeChildren = useSchemaStore(s => s.ensureTreeChildren);
  const ensureColumns = useSchemaStore(s => s.ensureColumns);

  // Store state for preloaded schemas (Postgres/MySQL-style)
  const autocompleteSchemas = useSchemaStore(s => s.autocompleteSchemas);

  const keywordSuggestions = useMemo(() => {
    const m = monaco as {
      languages?: { CompletionItemKind?: { Keyword?: number } };
    } | null;
    return SQL_KEYWORDS.map(keyword => ({
      label: keyword,
      kind: m?.languages?.CompletionItemKind?.Keyword,
      insertText: keyword,
    }));
  }, [monaco]);

  useEffect(() => {
    const dispose = () => {
      if (completionProviderRef.current) {
        completionProviderRef.current.dispose();
        completionProviderRef.current = null;
      }
    };

    dispose();

    if (!monaco) return dispose;

    const m = monaco as {
      languages: {
        registerCompletionItemProvider: (
          language: string,
          provider: unknown,
        ) => { dispose: () => void };
        CompletionItemKind: {
          Keyword: number;
          Class: number;
          Module: number;
          Field: number;
        };
      };
    };

    const limitSuggestions = <T>(items: T[], max = 150) =>
      items.length > max ? items.slice(0, max) : items;

    completionProviderRef.current = m.languages.registerCompletionItemProvider(
      "sql",
      {
        triggerCharacters: [".", " ", "`"],
        provideCompletionItems: async (
          model: {
            getValue: () => string;
            getValueInRange: (r: unknown) => string;
            getWordUntilPosition: (p: unknown) => {
              startColumn: number;
              endColumn: number;
            };
          },
          position: { lineNumber: number; column: number },
        ) => {
          // Get current context dynamically
          const workspaceId = getWorkspaceId();
          const connectionId = getConnectionId();
          const connectionType = getConnectionType();

          if (!workspaceId || !connectionId) {
            return {
              suggestions: keywordSuggestions.map(s => ({
                ...s,
                range: {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: 1,
                  endColumn: position.column,
                },
              })),
            };
          }

          const fullText = model.getValue();
          const textUntilPosition = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });

          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const keywordWithRange = keywordSuggestions.map(s => ({
            ...s,
            range,
          }));

          // Use lazy loading for BigQuery, preloaded schema for others
          const useLazyLoading = connectionType === "bigquery";

          if (useLazyLoading) {
            return provideLazyCompletions(
              m,
              workspaceId,
              connectionId,
              fullText,
              textUntilPosition,
              range,
              keywordWithRange,
              limitSuggestions,
              ensureTreeRoot,
              ensureTreeChildren,
              ensureColumns,
            );
          } else {
            const schema = autocompleteSchemas[connectionId];
            if (!schema) {
              return { suggestions: keywordWithRange };
            }
            return providePreloadedCompletions(
              m,
              schema,
              fullText,
              textUntilPosition,
              range,
              keywordWithRange,
              limitSuggestions,
            );
          }
        },
      },
    );

    return dispose;
  }, [
    monaco,
    keywordSuggestions,
    ensureTreeRoot,
    ensureTreeChildren,
    ensureColumns,
    autocompleteSchemas,
    getWorkspaceId,
    getConnectionId,
    getConnectionType,
  ]);
}

// ============================================================================
// Lazy Loading Completions (for BigQuery and other large schemas)
// ============================================================================

async function provideLazyCompletions(
  m: {
    languages: {
      CompletionItemKind: { Class: number; Module: number; Field: number };
    };
  },
  workspaceId: string,
  connectionId: string,
  fullText: string,
  textUntilPosition: string,
  range: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  },
  keywordWithRange: Array<{
    label: string;
    kind: number | undefined;
    insertText: string;
    range: typeof range;
  }>,
  limitSuggestions: <T>(items: T[], max?: number) => T[],
  ensureTreeRoot: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<Array<{ id: string; kind: string }>>,
  ensureTreeChildren: (
    workspaceId: string,
    connectionId: string,
    node: { id: string; kind: string },
  ) => Promise<Array<{ id: string; kind: string }>>,
  ensureColumns: (
    workspaceId: string,
    connectionId: string,
    schemaId: string,
    tableId: string,
  ) => Promise<Array<{ name: string; type: string }>>,
) {
  const getSchemas = async (): Promise<string[]> => {
    const nodes = await ensureTreeRoot(workspaceId, connectionId);
    return nodes
      .filter(n => ["dataset", "schema", "database"].includes(n.kind))
      .map(n => n.id);
  };

  const getTables = async (schemaId: string): Promise<string[]> => {
    const nodes = await ensureTreeChildren(workspaceId, connectionId, {
      id: schemaId,
      kind: "dataset",
    });
    return nodes.filter(n => n.kind === "table").map(n => n.id);
  };

  const getColumns = async (
    schemaId: string,
    tableId: string,
  ): Promise<{ name: string; type: string }[]> => {
    return ensureColumns(workspaceId, connectionId, schemaId, tableId);
  };

  // FROM/JOIN context
  const fromJoinToken = getFromOrJoinToken(textUntilPosition);
  if (fromJoinToken !== null) {
    const token = stripSqlIdentifierQuotes(fromJoinToken);

    if (token.includes(".")) {
      const parts = token.split(".");
      const schemaId = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
      const tablePrefix = parts.length >= 2 ? parts[parts.length - 1] : "";

      const allTables = await getTables(schemaId);
      const tables = tablePrefix
        ? allTables.filter(t =>
            t.toLowerCase().startsWith(tablePrefix.toLowerCase()),
          )
        : allTables;

      return {
        suggestions: limitSuggestions(
          tables.map(t => ({
            label: t,
            kind: m.languages.CompletionItemKind.Class,
            insertText: t,
            detail: `Table in ${schemaId}`,
            range,
          })),
        ),
      };
    }

    const allSchemas = await getSchemas();
    const tokenLower = token.toLowerCase();

    // Filter schemas that match the prefix
    const matchingSchemas = token
      ? allSchemas.filter(s => s.toLowerCase().startsWith(tokenLower))
      : allSchemas;

    const schemaSuggestions = matchingSchemas.map(s => ({
      label: s,
      kind: m.languages.CompletionItemKind.Module,
      insertText: s,
      detail: "Schema",
      range,
    }));

    // If exactly one schema matches, also show its tables
    if (matchingSchemas.length === 1) {
      const s = matchingSchemas[0];
      const tables = await getTables(s);
      const fullTableSuggestions = tables.slice(0, 100).map(t => ({
        label: `${s}.${t}`,
        kind: m.languages.CompletionItemKind.Class,
        insertText: `${s}.${t}`,
        detail: "Full Table Path",
        filterText: `${s}.${t} ${t}`,
        range,
      }));

      return {
        suggestions: limitSuggestions([
          ...schemaSuggestions,
          ...fullTableSuggestions,
        ]),
      };
    }

    // If no schemas match but user typed something, fetch tables from all schemas
    // and filter by table name (for smaller datasets this is okay)
    if (matchingSchemas.length === 0 && token && allSchemas.length <= 10) {
      const allTableSuggestions: typeof schemaSuggestions = [];

      for (const s of allSchemas) {
        const tables = await getTables(s);
        const matchingTables = tables.filter(t =>
          t.toLowerCase().startsWith(tokenLower),
        );

        for (const t of matchingTables) {
          allTableSuggestions.push({
            label: `${s}.${t}`,
            kind: m.languages.CompletionItemKind.Class,
            insertText: `${s}.${t}`,
            detail: "Full Table Path",
            range,
          });
          if (allTableSuggestions.length >= 50) break;
        }
        if (allTableSuggestions.length >= 50) break;
      }

      if (allTableSuggestions.length > 0) {
        return { suggestions: limitSuggestions(allTableSuggestions) };
      }
    }

    // Fallback: show all schemas so user can navigate
    if (matchingSchemas.length === 0) {
      return {
        suggestions: limitSuggestions(
          allSchemas.map(s => ({
            label: s,
            kind: m.languages.CompletionItemKind.Module,
            insertText: s,
            detail: "Schema",
            range,
          })),
        ),
      };
    }

    return { suggestions: limitSuggestions(schemaSuggestions) };
  }

  // Dot context
  const dotCtx = getDotContext(textUntilPosition);
  if (dotCtx) {
    const { aliasMap, lastTable } = parseTableContext(fullText);

    if (dotCtx.datasetId && dotCtx.tableId) {
      const cols = await getColumns(dotCtx.datasetId, dotCtx.tableId);
      return {
        suggestions: limitSuggestions(
          cols.map(c => ({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            insertText: c.name,
            detail: c.type,
            range,
          })),
        ),
      };
    }

    const ident = dotCtx.ident;
    const aliasTarget = aliasMap.get(ident);
    if (aliasTarget?.dataset) {
      const cols = await getColumns(aliasTarget.dataset, aliasTarget.table);
      return {
        suggestions: limitSuggestions(
          cols.map(c => ({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            insertText: c.name,
            detail: `${aliasTarget.dataset}.${aliasTarget.table} (${c.type})`,
            range,
          })),
        ),
      };
    }

    if (lastTable?.dataset) {
      const cols = await getColumns(lastTable.dataset, lastTable.table);
      const prefix = `${ident}.`;
      const children = new Map<string, string>();
      cols.forEach(c => {
        if (!c.name.startsWith(prefix)) return;
        const rest = c.name.slice(prefix.length);
        const child = rest.split(".")[0];
        if (child && !children.has(child)) {
          children.set(child, c.type);
        }
      });

      if (children.size > 0) {
        return {
          suggestions: limitSuggestions(
            Array.from(children.entries()).map(([child, type]) => ({
              label: child,
              kind: m.languages.CompletionItemKind.Field,
              insertText: child,
              detail: type,
              filterText: `${ident}.${child}`,
              range,
            })),
          ),
        };
      }
    }

    return { suggestions: keywordWithRange };
  }

  // WHERE/ON context
  if (/(?:WHERE|ON|AND|OR)\s+[`"\w.]*$/i.test(textUntilPosition)) {
    const { aliasMap, refs } = parseTableContext(fullText);
    const suggestions: Array<{
      label: string;
      kind: number;
      insertText: string;
      detail: string;
      range: typeof range;
    }> = [];

    const fetchFor = async (
      alias: string,
      ref: { dataset?: string; table: string },
    ) => {
      if (!ref?.dataset) return;
      const cols = await getColumns(ref.dataset, ref.table);
      cols.forEach(c => {
        suggestions.push({
          label: `${alias}.${c.name}`,
          kind: m.languages.CompletionItemKind.Field,
          insertText: `${alias}.${c.name}`,
          detail: `${ref.dataset}.${ref.table} (${c.type})`,
          range,
        });
      });
    };

    const aliasEntries = Array.from(aliasMap.entries());
    if (aliasEntries.length > 0) {
      await Promise.all(aliasEntries.map(([a, r]) => fetchFor(a, r)));
    } else {
      await Promise.all(refs.map(r => fetchFor(r.table, r)));
    }

    return {
      suggestions: limitSuggestions([...suggestions, ...keywordWithRange]),
    };
  }

  // SELECT context
  if (/\bSELECT\s+[^\n;]*$/i.test(textUntilPosition)) {
    const { lastTable } = parseTableContext(fullText);
    if (lastTable?.dataset) {
      const cols = await getColumns(lastTable.dataset, lastTable.table);
      return {
        suggestions: limitSuggestions([
          ...cols.map(c => ({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            insertText: c.name,
            detail: `${lastTable.dataset}.${lastTable.table} (${c.type})`,
            range,
          })),
          ...keywordWithRange,
        ]),
      };
    }
    return { suggestions: keywordWithRange };
  }

  return { suggestions: keywordWithRange };
}

// ============================================================================
// Preloaded Schema Completions (for Postgres, MySQL, etc.)
// ============================================================================

function providePreloadedCompletions(
  m: {
    languages: {
      CompletionItemKind: { Class: number; Module: number; Field: number };
    };
  },
  schema: Record<string, Record<string, Array<{ name: string; type: string }>>>,
  fullText: string,
  textUntilPosition: string,
  range: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  },
  keywordWithRange: Array<{
    label: string;
    kind: number | undefined;
    insertText: string;
    range: typeof range;
  }>,
  limitSuggestions: <T>(items: T[], max?: number) => T[],
) {
  const findColumnsForRef = (ref?: { dataset?: string; table: string }) => {
    if (!ref) return [];
    const table = ref.table;
    const ds = ref.dataset;

    if (ds && schema[ds]?.[table]) {
      return schema[ds][table].map(c => ({
        name: String(c?.name || ""),
        type: String(c?.type || ""),
        dataset: ds,
        table,
      }));
    }

    for (const datasetId of Object.keys(schema)) {
      if (schema[datasetId]?.[table]) {
        return schema[datasetId][table].map(c => ({
          name: String(c?.name || ""),
          type: String(c?.type || ""),
          dataset: datasetId,
          table,
        }));
      }
    }

    return [];
  };

  // Dot context
  const dotCtx = getDotContext(textUntilPosition);
  if (dotCtx) {
    const { aliasMap } = parseTableContext(fullText);

    if (dotCtx.datasetId && dotCtx.tableId) {
      const cols = schema[dotCtx.datasetId]?.[dotCtx.tableId];
      if (cols?.length) {
        return {
          suggestions: limitSuggestions(
            cols.map(c => ({
              label: c.name,
              kind: m.languages.CompletionItemKind.Field,
              insertText: c.name,
              detail: c.type,
              range,
            })),
          ),
        };
      }
    }

    const ident = dotCtx.ident;
    const aliasTarget = aliasMap.get(ident);
    if (aliasTarget) {
      const cols = findColumnsForRef(aliasTarget);
      if (cols.length) {
        return {
          suggestions: limitSuggestions(
            cols.map(c => ({
              label: c.name,
              kind: m.languages.CompletionItemKind.Field,
              insertText: c.name,
              detail: `${c.dataset}.${c.table} (${c.type})`,
              range,
            })),
          ),
        };
      }
    }

    const ds = stripSqlIdentifierQuotes(ident);
    if (schema[ds]) {
      const tables = Object.keys(schema[ds]);
      return {
        suggestions: limitSuggestions(
          tables.map(t => ({
            label: t,
            kind: m.languages.CompletionItemKind.Class,
            insertText: t,
            detail: `Table in ${ds}`,
            range,
          })),
        ),
      };
    }
  }

  // FROM/JOIN context
  const fromJoinToken = getFromOrJoinToken(textUntilPosition);
  if (fromJoinToken !== null) {
    const token = stripSqlIdentifierQuotes(fromJoinToken);

    if (token.includes(".")) {
      const [ds, tablePrefix = ""] = token.split(".", 2);
      if (schema[ds]) {
        const tables = Object.keys(schema[ds]).filter(t =>
          tablePrefix ? t.startsWith(tablePrefix) : true,
        );
        return {
          suggestions: limitSuggestions(
            tables.map(t => ({
              label: t,
              kind: m.languages.CompletionItemKind.Class,
              insertText: t,
              detail: `Table in ${ds}`,
              range,
            })),
          ),
        };
      }
    }

    const prefix = token.toLowerCase();
    const suggestions: Array<{
      label: string;
      kind: number;
      insertText: string;
      detail: string;
      filterText?: string;
      range: typeof range;
    }> = [];

    const allSchemas = Object.keys(schema).sort((a, b) => a.localeCompare(b));

    for (const ds of allSchemas) {
      // Include schema if it matches the prefix
      if (!prefix || ds.toLowerCase().startsWith(prefix)) {
        suggestions.push({
          label: ds,
          kind: m.languages.CompletionItemKind.Module,
          insertText: ds,
          detail: "Schema",
          range,
        });
      }

      // Include tables that match the prefix (by table name or full path)
      for (const table of Object.keys(schema[ds] || {})) {
        const fullPath = `${ds}.${table}`;
        const matchesPrefix =
          !prefix ||
          table.toLowerCase().startsWith(prefix) ||
          fullPath.toLowerCase().startsWith(prefix);

        if (matchesPrefix) {
          suggestions.push({
            label: fullPath,
            kind: m.languages.CompletionItemKind.Class,
            insertText: fullPath,
            detail: "Full Table Path",
            filterText: `${fullPath} ${table}`,
            range,
          });
        }
        if (suggestions.length >= 150) break;
      }
      if (suggestions.length >= 150) break;
    }

    return { suggestions: limitSuggestions(suggestions) };
  }

  // WHERE/ON context
  if (/(?:WHERE|ON|AND|OR)\s+[`"\w.]*$/i.test(textUntilPosition)) {
    const { aliasMap, refs } = parseTableContext(fullText);
    const suggestions: Array<{
      label: string;
      kind: number;
      insertText: string;
      detail: string;
      range: typeof range;
    }> = [];

    const aliasEntries = Array.from(aliasMap.entries());
    if (aliasEntries.length > 0) {
      for (const [alias, ref] of aliasEntries) {
        const cols = findColumnsForRef(ref);
        for (const c of cols) {
          suggestions.push({
            label: `${alias}.${c.name}`,
            kind: m.languages.CompletionItemKind.Field,
            insertText: `${alias}.${c.name}`,
            detail: `${c.dataset}.${c.table} (${c.type})`,
            range,
          });
        }
        if (suggestions.length >= 150) break;
      }
    } else {
      for (const ref of refs) {
        const cols = findColumnsForRef(ref);
        for (const c of cols) {
          suggestions.push({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            insertText: c.name,
            detail: `${c.dataset}.${c.table} (${c.type})`,
            range,
          });
        }
        if (suggestions.length >= 150) break;
      }
    }

    return {
      suggestions: limitSuggestions([...suggestions, ...keywordWithRange]),
    };
  }

  // SELECT context
  if (/\bSELECT\s+[^\n;]*$/i.test(textUntilPosition)) {
    const { lastTable } = parseTableContext(fullText);
    const cols = findColumnsForRef(lastTable || undefined);
    if (cols.length) {
      return {
        suggestions: limitSuggestions([
          ...cols.map(c => ({
            label: c.name,
            kind: m.languages.CompletionItemKind.Field,
            insertText: c.name,
            detail: `${c.dataset}.${c.table} (${c.type})`,
            range,
          })),
          ...keywordWithRange,
        ]),
      };
    }
    return { suggestions: keywordWithRange };
  }

  return { suggestions: keywordWithRange };
}
