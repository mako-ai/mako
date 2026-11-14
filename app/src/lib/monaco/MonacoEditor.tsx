/**
 * Drop-in replacements for @monaco-editor/react's `Editor` / `DiffEditor`
 * that load the locally bundled Monaco on first render (see ./setup.ts).
 * Import editors from here, never from "@monaco-editor/react" directly:
 * a direct import could call `loader.init()` before the bundled instance is
 * configured and fall back to the CDN.
 */
import { lazy, Suspense, type ReactNode } from "react";
import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";
import { loadMonacoReact } from "./load";

export type { Monaco } from "./load";

export type {
  BeforeMount,
  DiffBeforeMount,
  DiffEditorProps,
  DiffOnMount,
  EditorProps,
  OnChange,
  OnMount,
  OnValidate,
} from "@monaco-editor/react";

const LazyEditor = lazy(() =>
  loadMonacoReact().then(m => ({ default: m.Editor })),
);
const LazyDiffEditor = lazy(() =>
  loadMonacoReact().then(m => ({ default: m.DiffEditor })),
);

/** Same box and placeholder @monaco-editor/react shows while it loads. */
function EditorFallback({
  width,
  height,
  loading,
}: {
  width?: number | string;
  height?: number | string;
  loading?: ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        position: "relative",
        textAlign: "initial",
        width: width ?? "100%",
        height: height ?? "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {loading ?? "Loading..."}
      </div>
    </section>
  );
}

export function Editor(props: EditorProps) {
  return (
    <Suspense
      fallback={
        <EditorFallback
          width={props.width}
          height={props.height}
          loading={props.loading}
        />
      }
    >
      <LazyEditor {...props} />
    </Suspense>
  );
}

export function DiffEditor(props: DiffEditorProps) {
  return (
    <Suspense
      fallback={
        <EditorFallback
          width={props.width}
          height={props.height}
          loading={props.loading}
        />
      }
    >
      <LazyDiffEditor {...props} />
    </Suspense>
  );
}

export default Editor;
