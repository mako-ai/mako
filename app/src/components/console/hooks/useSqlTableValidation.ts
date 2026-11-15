import { useEffect } from "react";
import type { AutocompleteSchema } from "../../../store/schemaStore";
import { findUnknownTableRefs } from "../console-utils";

/**
 * Debounced warning markers for FROM/JOIN tables the connection's schema
 * does not know. Re-attaches when the editor mounts (monacoInstance), the
 * connection, or its schema changes; clears its markers on teardown.
 */
export function useSqlTableValidation(
  monacoInstance: any,
  editorRef: React.RefObject<any>,
  connectionId: string | undefined,
  autocompleteSchemas: Record<string, AutocompleteSchema>,
) {
  useEffect(() => {
    if (!monacoInstance || !connectionId || !editorRef.current) return;

    const schema = autocompleteSchemas[connectionId];
    if (!schema) return;

    // Use a separate timeout ref for validation so we don't interfere with the main save/undo debounce
    const validationTimeoutRef = { current: null as NodeJS.Timeout | null };

    const validateContent = () => {
      const model = editorRef.current?.getModel();
      if (!model) return;

      const markers = findUnknownTableRefs(model.getValue(), schema).map(
        ref => {
          const startPos = model.getPositionAt(ref.start);
          const endPos = model.getPositionAt(ref.end);
          return {
            severity: monacoInstance.MarkerSeverity.Warning,
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
            message: `Table '${ref.name}' not found in schema`,
          };
        },
      );

      monacoInstance.editor.setModelMarkers(model, "sql-validation", markers);
    };

    // Run validation initially
    validateContent();

    // Set up debounced validation on change
    const disposer = editorRef.current.onDidChangeModelContent(() => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      validationTimeoutRef.current = setTimeout(validateContent, 1000);
    });

    return () => {
      disposer.dispose();
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      const model = editorRef.current?.getModel();
      if (model) {
        monacoInstance.editor.setModelMarkers(model, "sql-validation", []);
      }
    };
  }, [connectionId, autocompleteSchemas, monacoInstance, editorRef]);
}
