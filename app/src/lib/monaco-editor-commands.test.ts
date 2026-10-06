import { describe, expect, it, vi } from "vitest";
import {
  addEditorShortcut,
  consoleShortcutApplies,
  type ActionEditor,
} from "./monaco-editor-commands";

const CMD_S = 2048 | 49;

/**
 * A fake editor that records what it was asked to bind. `addCommand` is
 * Monaco's page-wide registration — the bug — so the fake throws on it.
 */
function fakeEditor() {
  const actions: Array<{
    id: string;
    keybindings?: number[];
    run: () => void;
  }> = [];
  const editor = {
    addAction: vi.fn(
      (d: { id: string; keybindings?: number[]; run: () => void }) => {
        actions.push(d);
        return { dispose: vi.fn() };
      },
    ),
    addCommand: () => {
      throw new Error("addCommand binds the chord page-wide");
    },
  };
  /** The person presses `chord` while THIS editor has focus. */
  const press = (chord: number) => {
    for (const a of actions) if (a.keybindings?.includes(chord)) a.run();
  };
  return { editor: editor as unknown as ActionEditor, actions, press };
}

describe("addEditorShortcut", () => {
  it("binds the chord to the editor through addAction, never addCommand", () => {
    const { editor, actions } = fakeEditor();
    const run = vi.fn();
    addEditorShortcut(editor, {
      id: "mako.console.save",
      label: "Save console",
      keybinding: CMD_S,
      run,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("mako.console.save");
    expect(actions[0].keybindings).toEqual([CMD_S]);
  });

  it("⌘S in one console saves that console, not the one mounted last", () => {
    // After a reload every tab mounts; the background tab mounts last.
    const active = fakeEditor();
    const background = fakeEditor();
    const saved: string[] = [];
    addEditorShortcut(active.editor, {
      id: "mako.console.save",
      label: "Save console",
      keybinding: CMD_S,
      run: () => saved.push("active"),
    });
    addEditorShortcut(background.editor, {
      id: "mako.console.save",
      label: "Save console",
      keybinding: CMD_S,
      run: () => saved.push("background"),
    });

    active.press(CMD_S);
    expect(saved).toEqual(["active"]);
  });

  it("hands back the registration's disposer", () => {
    const { editor } = fakeEditor();
    const handle = addEditorShortcut(editor, {
      id: "x",
      label: "x",
      keybinding: CMD_S,
      run: () => {},
    });
    expect(typeof handle.dispose).toBe("function");
  });
});

describe("consoleShortcutApplies", () => {
  const tabs = { a: {}, b: {} };

  it("answers for the visible console tab only", () => {
    expect(consoleShortcutApplies("a", { activeTabId: "a", tabs })).toBe(true);
    expect(consoleShortcutApplies("b", { activeTabId: "a", tabs })).toBe(false);
  });

  it("always answers for an editor that is not a console tab (app binding)", () => {
    expect(
      consoleShortcutApplies("binding:app:q.sql", { activeTabId: "a", tabs }),
    ).toBe(true);
  });
});
