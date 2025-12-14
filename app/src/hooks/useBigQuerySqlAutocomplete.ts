import { useEffect, useMemo, useRef } from "react";
import { useBigQueryAutocompleteStore } from "../store/bigQueryAutocompleteStore";
import {
  getDotContext,
  getFromOrJoinToken,
  parseTableContext,
  stripSqlIdentifierQuotes,
} from "../lib/sql-autocomplete/sqlContext";
import { SQL_KEYWORDS } from "../lib/sql-autocomplete/sqlKeywords";

type Monaco = any;

type UseBigQuerySqlAutocompleteArgs = {
  enabled: boolean;
  monaco: Monaco | null;
  workspaceId: string | undefined;
  connectionId: string | undefined;
};

export function useBigQuerySqlAutocomplete({
  enabled,
  monaco,
  workspaceId,
  connectionId,
}: UseBigQuerySqlAutocompleteArgs) {
  const completionProviderRef = useRef<any>(null);

  const fetchDatasets = useBigQueryAutocompleteStore(s => s.fetchDatasets);
  const fetchTables = useBigQueryAutocompleteStore(s => s.fetchTables);
  const fetchColumns = useBigQueryAutocompleteStore(s => s.fetchColumns);

  const keywordSuggestions = useMemo(() => {
    return SQL_KEYWORDS.map(keyword => ({
      label: keyword,
      kind: monaco?.languages?.CompletionItemKind?.Keyword,
      insertText: keyword,
    }));
  }, [monaco]);

  useEffect(() => {
    if (!enabled || !monaco || !workspaceId || !connectionId) return;

    // Dispose previous provider
    if (completionProviderRef.current) {
      completionProviderRef.current.dispose();
      completionProviderRef.current = null;
    }

    const limitSuggestions = (items: any[], max = 150) =>
      items.length > max ? items.slice(0, max) : items;

    completionProviderRef.current =
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [".", " ", "`"],
        provideCompletionItems: async (model: any, position: any) => {
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
              const cols = await fetchColumns({
                workspaceId,
                connectionId,
                datasetId: dotCtx.datasetId,
                tableId: dotCtx.tableId,
              });

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

            // alias.
            const ident = dotCtx.ident;
            const aliasTarget = aliasMap.get(ident);
            if (aliasTarget?.dataset) {
              const cols = await fetchColumns({
                workspaceId,
                connectionId,
                datasetId: aliasTarget.dataset,
                tableId: aliasTarget.table,
              });

              return {
                suggestions: limitSuggestions(
                  cols.map(c => ({
                    label: c.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: c.name,
                    detail: `${aliasTarget.dataset}.${aliasTarget.table} (${c.type})`,
                    range,
                  })),
                  150,
                ),
              };
            }

            // dataset.
            const tables = await fetchTables({
              workspaceId,
              connectionId,
              datasetId: stripSqlIdentifierQuotes(ident),
              prefix: "",
              limit: 150,
            });

            return {
              suggestions: limitSuggestions(
                tables.map(t => ({
                  label: t,
                  kind: monaco.languages.CompletionItemKind.Class,
                  insertText: t,
                  detail: `Table in ${ident}`,
                  range,
                })),
                150,
              ),
            };
          }

          // 2) FROM/JOIN context
          const fromJoinToken = getFromOrJoinToken(textUntilPosition);
          if (fromJoinToken !== null) {
            const token = stripSqlIdentifierQuotes(fromJoinToken);

            // dataset.tablePrefix (also supports project.dataset.tablePrefix)
            if (token.includes(".")) {
              const parts = token.split(".");
              const datasetId =
                parts.length >= 3 ? parts[parts.length - 2] : parts[0];
              const tablePrefix =
                parts.length >= 2 ? parts[parts.length - 1] : "";
              const tables = await fetchTables({
                workspaceId,
                connectionId,
                datasetId,
                prefix: tablePrefix,
                limit: 150,
              });

              return {
                suggestions: limitSuggestions(
                  tables.map(t => ({
                    label: t,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: t,
                    detail: `Table in ${datasetId}`,
                    range,
                  })),
                  150,
                ),
              };
            }

            // datasetPrefix
            const datasets = await fetchDatasets({
              workspaceId,
              connectionId,
              prefix: token,
              limit: 100,
            });
            const datasetSuggestions = datasets.map(ds => ({
              label: ds,
              kind: monaco.languages.CompletionItemKind.Module,
              insertText: ds,
              detail: "Dataset",
              range,
            }));

            // If we narrowed to a single dataset, also show fully qualified tables
            if (datasets.length === 1) {
              const ds = datasets[0];
              const tables = await fetchTables({
                workspaceId,
                connectionId,
                datasetId: ds,
                prefix: "",
                limit: 100,
              });
              const fullTableSuggestions = tables.map(t => ({
                label: `${ds}.${t}`,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: `${ds}.${t}`,
                detail: "Full Table Path",
                filterText: `${ds}.${t} ${t}`,
                range,
              }));

              return {
                suggestions: limitSuggestions(
                  [...datasetSuggestions, ...fullTableSuggestions],
                  150,
                ),
              };
            }

            return {
              suggestions: limitSuggestions(datasetSuggestions, 150),
            };
          }

          // 3) WHERE/ON context -> columns from all tables in query (prefer alias.column)
          const isWhereContext = /(?:WHERE|ON|AND|OR)\s+[`"\w.]*$/i.test(
            textUntilPosition,
          );
          if (isWhereContext) {
            const { aliasMap, refs } = parseTableContext(fullText);

            const suggestions: any[] = [];
            // Prefer alias-qualified suggestions if we have aliases
            const aliasEntries = Array.from(aliasMap.entries());

            const fetchFor = async (alias: string, ref: any) => {
              if (!ref?.dataset) return;
              const cols = await fetchColumns({
                workspaceId,
                connectionId,
                datasetId: ref.dataset,
                tableId: ref.table,
              });
              cols.forEach(c => {
                suggestions.push({
                  label: `${alias}.${c.name}`,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: `${alias}.${c.name}`,
                  detail: `${ref.dataset}.${ref.table} (${c.type})`,
                  range,
                });
              });
            };

            // If there are explicit aliases, use those; otherwise fall back to table refs.
            if (aliasEntries.length > 0) {
              await Promise.all(aliasEntries.map(([a, r]) => fetchFor(a, r)));
            } else {
              await Promise.all(refs.map(r => fetchFor(r.table, r)));
            }

            return {
              suggestions: limitSuggestions(
                [...suggestions, ...keywordWithRange],
                150,
              ),
            };
          }

          // 4) SELECT context -> columns from last table (keeps noise down)
          const isSelectContext = /\bSELECT\s+[^\n;]*$/i.test(
            textUntilPosition,
          );
          if (isSelectContext) {
            const { lastTable } = parseTableContext(fullText);
            if (lastTable?.dataset) {
              const cols = await fetchColumns({
                workspaceId,
                connectionId,
                datasetId: lastTable.dataset,
                tableId: lastTable.table,
              });

              const columnSuggestions = cols.map(c => ({
                label: c.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name,
                detail: `${lastTable.dataset}.${lastTable.table} (${c.type})`,
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

          // Default: keywords only
          return { suggestions: keywordWithRange };
        },
      });

    return () => {
      if (completionProviderRef.current) {
        completionProviderRef.current.dispose();
        completionProviderRef.current = null;
      }
    };
  }, [
    enabled,
    monaco,
    workspaceId,
    connectionId,
    fetchDatasets,
    fetchTables,
    fetchColumns,
    keywordSuggestions,
  ]);
}
