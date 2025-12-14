import { useEffect, useMemo, useRef } from "react";
import {
  getDotContext,
  getFromOrJoinToken,
  parseTableContext,
  stripSqlIdentifierQuotes,
} from "../lib/sql-autocomplete/sqlContext";
import { SQL_KEYWORDS } from "../lib/sql-autocomplete/sqlKeywords";

type Monaco = any;

type UseSchemaSqlAutocompleteArgs = {
  enabled: boolean;
  monaco: Monaco | null;
  schema: Record<string, any> | null | undefined;
};

export function useSchemaSqlAutocomplete({
  enabled,
  monaco,
  schema,
}: UseSchemaSqlAutocompleteArgs) {
  const completionProviderRef = useRef<any>(null);

  const keywordSuggestions = useMemo(() => {
    return SQL_KEYWORDS.map(keyword => ({
      label: keyword,
      kind: monaco?.languages?.CompletionItemKind?.Keyword,
      insertText: keyword,
    }));
  }, [monaco]);

  useEffect(() => {
    if (!enabled || !monaco || !schema) return;

    if (completionProviderRef.current) {
      completionProviderRef.current.dispose();
      completionProviderRef.current = null;
    }

    const limitSuggestions = (items: any[], max = 150) =>
      items.length > max ? items.slice(0, max) : items;

    const findColumnsForRef = (ref?: { dataset?: string; table: string }) => {
      if (!ref) return [];
      const table = ref.table;
      const ds = ref.dataset;

      if (ds && schema[ds] && schema[ds][table]) {
        return (schema[ds][table] as any[]).map(c => ({
          name: String(c?.name || ""),
          type: String(c?.type || ""),
          dataset: ds,
          table,
        }));
      }

      // fallback: search by table name across datasets/schemas
      for (const datasetId of Object.keys(schema)) {
        if (schema[datasetId] && schema[datasetId][table]) {
          return (schema[datasetId][table] as any[]).map(c => ({
            name: String(c?.name || ""),
            type: String(c?.type || ""),
            dataset: datasetId,
            table,
          }));
        }
      }

      return [];
    };

    completionProviderRef.current =
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [".", " ", "`"],
        provideCompletionItems: (model: any, position: any) => {
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

          // 1) Dot context
          const dotCtx = getDotContext(textUntilPosition);
          if (dotCtx) {
            const { aliasMap } = parseTableContext(fullText);

            // dataset.table.
            if (dotCtx.datasetId && dotCtx.tableId) {
              const cols = schema[dotCtx.datasetId]?.[dotCtx.tableId] as
                | Array<{ name: string; type: string }>
                | undefined;
              if (cols && cols.length > 0) {
                return {
                  suggestions: limitSuggestions(
                    cols.map(c => ({
                      label: c.name,
                      kind: monaco.languages.CompletionItemKind.Field,
                      insertText: c.name,
                      detail: c.type,
                      range,
                    })),
                    150,
                  ),
                };
              }
            }

            // alias.
            const ident = dotCtx.ident;
            const aliasTarget = aliasMap.get(ident);
            if (aliasTarget) {
              const cols = findColumnsForRef(aliasTarget);
              if (cols.length > 0) {
                return {
                  suggestions: limitSuggestions(
                    cols.map(c => ({
                      label: c.name,
                      kind: monaco.languages.CompletionItemKind.Field,
                      insertText: c.name,
                      detail: `${c.dataset}.${c.table} (${c.type})`,
                      range,
                    })),
                    150,
                  ),
                };
              }
            }

            // dataset.
            const ds = stripSqlIdentifierQuotes(ident);
            if (schema[ds]) {
              const tables = Object.keys(schema[ds]);
              return {
                suggestions: limitSuggestions(
                  tables.map(t => ({
                    label: t,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: t,
                    detail: `Table in ${ds}`,
                    range,
                  })),
                  150,
                ),
              };
            }
          }

          // 2) FROM/JOIN context
          const fromJoinToken = getFromOrJoinToken(textUntilPosition);
          if (fromJoinToken !== null) {
            const token = stripSqlIdentifierQuotes(fromJoinToken);

            // dataset.tablePrefix
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
                      kind: monaco.languages.CompletionItemKind.Class,
                      insertText: t,
                      detail: `Table in ${ds}`,
                      range,
                    })),
                    150,
                  ),
                };
              }
            }

            // datasetPrefix -> datasets + fully qualified tables (capped)
            const prefix = token;
            const suggestions: any[] = [];
            const datasets = Object.keys(schema)
              .filter(ds => (prefix ? ds.startsWith(prefix) : true))
              .sort((a, b) => a.localeCompare(b));

            for (const ds of datasets) {
              suggestions.push({
                label: ds,
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: ds,
                detail: "Dataset",
                range,
              });

              for (const table of Object.keys(schema[ds] || {})) {
                suggestions.push({
                  label: `${ds}.${table}`,
                  kind: monaco.languages.CompletionItemKind.Class,
                  insertText: `${ds}.${table}`,
                  detail: "Full Table Path",
                  filterText: `${ds}.${table} ${table}`,
                  range,
                });
                if (suggestions.length >= 150) break;
              }
              if (suggestions.length >= 150) break;
            }

            return { suggestions: limitSuggestions(suggestions, 150) };
          }

          // 3) WHERE/ON context -> alias-qualified columns from all referenced tables
          const isWhereContext = /(?:WHERE|ON|AND|OR)\s+[`"\w.]*$/i.test(
            textUntilPosition,
          );
          if (isWhereContext) {
            const { aliasMap, refs } = parseTableContext(fullText);
            const suggestions: any[] = [];

            const aliasEntries = Array.from(aliasMap.entries());
            if (aliasEntries.length > 0) {
              for (const [alias, ref] of aliasEntries) {
                const cols = findColumnsForRef(ref);
                cols.forEach(c => {
                  suggestions.push({
                    label: `${alias}.${c.name}`,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: `${alias}.${c.name}`,
                    detail: `${c.dataset}.${c.table} (${c.type})`,
                    range,
                  });
                });
                if (suggestions.length >= 150) break;
              }
            } else {
              for (const ref of refs) {
                const cols = findColumnsForRef(ref);
                cols.forEach(c => {
                  suggestions.push({
                    label: c.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: c.name,
                    detail: `${c.dataset}.${c.table} (${c.type})`,
                    range,
                  });
                });
                if (suggestions.length >= 150) break;
              }
            }

            return {
              suggestions: limitSuggestions(
                [...suggestions, ...keywordWithRange],
                150,
              ),
            };
          }

          // 4) SELECT context -> columns from last table
          const isSelectContext = /\bSELECT\s+[^\n;]*$/i.test(
            textUntilPosition,
          );
          if (isSelectContext) {
            const { lastTable } = parseTableContext(fullText);
            const cols = findColumnsForRef(lastTable || undefined);
            if (cols.length > 0) {
              const columnSuggestions = cols.map(c => ({
                label: c.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name,
                detail: `${c.dataset}.${c.table} (${c.type})`,
                range,
              }));
              return {
                suggestions: limitSuggestions(
                  [...columnSuggestions, ...keywordWithRange],
                  150,
                ),
              };
            }
            return { suggestions: keywordWithRange };
          }

          return { suggestions: keywordWithRange };
        },
      });

    return () => {
      if (completionProviderRef.current) {
        completionProviderRef.current.dispose();
        completionProviderRef.current = null;
      }
    };
  }, [enabled, monaco, schema, keywordSuggestions]);
}
