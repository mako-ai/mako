import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Monaco, OnMount } from "../../lib/monaco/MonacoEditor";
import { useMonacoTheme } from "../../lib/monaco-presets";
import { useSqlAutocomplete } from "../../hooks/useSqlAutocomplete";
import {
  dbFlowQueryModelPath,
  modelUriMatchesPath,
  modelUriOf,
} from "../../lib/sql-autocomplete/modelScope";

/** The `{{…}}` placeholders the sync runtime substitutes into the query. */
export const QUERY_TEMPLATE_PLACEHOLDERS = [
  {
    label: "limit}}",
    detail: "Batch size (e.g., 2000)",
    documentation:
      "Replaced with the batch size at runtime. Controls how many rows are fetched per iteration.",
  },
  {
    label: "offset}}",
    detail: "Current offset for pagination",
    documentation:
      "Replaced with the current pagination offset. Increments by batch size each iteration (0, 2000, 4000, ...).",
  },
  {
    label: "last_sync_value}}",
    detail: "Last value of tracking column",
    documentation:
      "Replaced with the last synced value of the tracking column. Used for incremental sync to only fetch new/changed data.",
  },
  {
    label: "keyset_value}}",
    detail: "Last keyset column value",
    documentation:
      "Replaced with the last value of the keyset column. Used for keyset pagination which is more efficient than offset for large tables.",
  },
];

interface DbQueryEditorOptions {
  getWorkspaceId: () => string | undefined;
  getConnectionId: () => string | undefined;
  getConnectionType: () => string | undefined;
}

/**
 * The source-query Monaco editor's wiring: a model path unique to this form,
 * `{{placeholder}}` completions and schema-aware SQL autocomplete — both
 * scoped to that model so they neither leak into consoles nor into another
 * open flow form.
 */
export function useDbQueryEditor({
  getWorkspaceId,
  getConnectionId,
  getConnectionType,
}: DbQueryEditorOptions) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  // State, not a ref: the SQL autocomplete hook must see the instance once
  // the editor mounts (a ref read during render stayed null).
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);
  const queryModelPath = dbFlowQueryModelPath(useId());
  const queryModelPathRef = useRef(queryModelPath);
  queryModelPathRef.current = queryModelPath;
  const templateCompletionDisposable = useRef<{ dispose: () => void } | null>(
    null,
  );
  const monacoTheme = useMonacoTheme();

  const registerTemplateCompletions = useCallback((monaco: Monaco) => {
    templateCompletionDisposable.current?.dispose();
    templateCompletionDisposable.current =
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: ["{"],
        provideCompletionItems: (model, position) => {
          if (
            !modelUriMatchesPath(modelUriOf(model), queryModelPathRef.current)
          ) {
            return { suggestions: [] };
          }
          const textBefore = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: Math.max(1, position.column - 2),
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          if (textBefore !== "{{") {
            return { suggestions: [] };
          }

          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: QUERY_TEMPLATE_PLACEHOLDERS.map(p => ({
              ...p,
              insertText: p.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              range,
            })),
          };
        },
      });
  }, []);

  useEffect(
    () => () => {
      templateCompletionDisposable.current?.dispose();
    },
    [],
  );

  useSqlAutocomplete({
    monaco: monacoInstance,
    getWorkspaceId,
    acceptsModel: uri => modelUriMatchesPath(uri, queryModelPath),
    getConnectionId,
    getConnectionType,
  });

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setMonacoInstance(monaco);
    registerTemplateCompletions(monaco);
  };

  return { editorRef, queryModelPath, monacoTheme, onEditorMount };
}
