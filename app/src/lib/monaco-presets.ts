/**
 * One place for how Mako configures Monaco.
 *
 * Every `<Editor>` / `<DiffEditor>` used to hand-write its own `options`
 * block and derive its theme its own way — and the light theme disagreed:
 * "vs" in some files, "light" in others. Monaco registers only `vs`,
 * `vs-dark`, `hc-black` and `hc-light`; an unknown name such as "light"
 * silently falls back to `vs`, so both rendered the same — by accident.
 * `useMonacoTheme` is the one rule, and it names the theme Monaco actually
 * has.
 *
 * The presets are the common denominators of the blocks they replaced; a
 * site keeps its own deviations as a spread:
 * `options={{ ...EDITOR_OPTIONS.code, wordWrap: "on" }}`.
 *
 * `automaticLayout` is listed explicitly even though @monaco-editor/react
 * already creates every editor with `{ automaticLayout: true, ...options }`,
 * so a preset means the same thing whether or not it goes through the
 * wrapper.
 */
import { useTheme } from "@mui/material/styles";
import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";

export type MonacoTheme = "vs" | "vs-dark";

/** Monaco theme matching the current MUI palette mode. */
export function useMonacoTheme(): MonacoTheme {
  return useTheme().palette.mode === "dark" ? "vs-dark" : "vs";
}

type EditorOptions = NonNullable<EditorProps["options"]>;
type DiffEditorOptions = NonNullable<DiffEditorProps["options"]>;

const base = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
} satisfies EditorOptions;

export const EDITOR_OPTIONS = {
  /** Full-height source editor: file editors, plan documents, consoles. */
  code: { ...base, fontSize: 13 },
  /** Read-only viewer: compiled SQL, JSON results, version snapshots. */
  readOnly: { ...base, readOnly: true, fontSize: 12, wordWrap: "on" },
  /** Compact editor embedded in a form or inspector: no line numbers. */
  inline: { ...base, lineNumbers: "off", fontSize: 12, wordWrap: "on" },
  /** Read-only side-by-side diff. */
  diff: {
    ...base,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    fontSize: 13,
  },
} satisfies {
  code: EditorOptions;
  readOnly: EditorOptions;
  inline: EditorOptions;
  diff: DiffEditorOptions;
};
