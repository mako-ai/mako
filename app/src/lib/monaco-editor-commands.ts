/**
 * Keyboard shortcuts that belong to ONE Monaco editor.
 *
 * `editor.addCommand` is not per-editor: it registers a keybinding with the
 * page-wide standalone keybinding service, with no condition, and the LAST
 * registration of a chord wins wherever the focus is. Every console tab
 * stays mounted, so after a reload the last-mounted editor owned ⌘S — the
 * e2e pressed ⌘S in the console being edited and the server committed a
 * background tab's draft ("Console saved to 'New Folder/Ghost.sql'"), twice.
 * A mounted dbt file editor took ⌘S and ⌘↵ from every console the same way.
 *
 * `editor.addAction` registers the same keybinding with the precondition
 * `editorId == <this editor>`, which Monaco evaluates in the FOCUSED
 * editor's context: the shortcut runs for the editor the person is typing
 * in, and for no other. The disposable it returns is the editor's to drop.
 */

/** The slice of a Monaco editor this needs (tests pass a fake). */
export interface ActionEditor {
  addAction: (descriptor: {
    id: string;
    label: string;
    keybindings?: number[];
    run: (...args: unknown[]) => void | Promise<void>;
  }) => { dispose: () => void };
}

export interface EditorShortcut {
  /** Unique per editor; Monaco prefixes it with the editor's id. */
  id: string;
  /** Shown in the command palette (F1). */
  label: string;
  /** A Monaco keybinding (`KeyMod.CtrlCmd | KeyCode.KeyS`). */
  keybinding: number;
  run: () => void;
}

/** Bind `shortcut` to `editor` only. Returns the registration's disposer. */
export function addEditorShortcut(
  editor: ActionEditor,
  shortcut: EditorShortcut,
): { dispose: () => void } {
  return editor.addAction({
    id: shortcut.id,
    label: shortcut.label,
    keybindings: [shortcut.keybinding],
    run: () => {
      shortcut.run();
    },
  });
}

/**
 * A console editor answers its shortcuts only while it is the visible tab.
 * Focus already scopes them (above); this keeps a hidden tab from acting
 * should focus ever linger in it. An editor that is not a console tab at
 * all (a dashboard data source, an app binding) has no tab to compare and
 * always answers.
 */
export function consoleShortcutApplies(
  consoleId: string,
  state: { activeTabId: string | null; tabs: Record<string, unknown> },
): boolean {
  if (!state.tabs[consoleId]) return true;
  return state.activeTabId === consoleId;
}
