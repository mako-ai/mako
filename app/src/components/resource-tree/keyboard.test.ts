// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isTextEntryTarget, treeOwnsUndo } from "./utils";

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the tree's window shortcuts", () => {
  it("never read a key typed into a field or the code editor", () => {
    const host = el(`
      <input id="i" /><textarea id="t"></textarea>
      <div class="monaco-editor"><div id="m" tabindex="0"></div></div>
      <div id="ce" contenteditable="true"></div>
      <button id="b">x</button>
    `);
    const get = (id: string) => host.querySelector(`#${id}`);
    for (const id of ["i", "t", "m", "ce"]) {
      expect(isTextEntryTarget(get(id)), id).toBe(true);
    }
    expect(isTextEntryTarget(get("b"))).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it("take Ctrl+Z only with the focus in the tree, or nowhere", () => {
    const host = el(`
      <nav id="tree"><div id="row" tabindex="0"></div></nav>
      <div class="monaco-editor"><div id="editor" tabindex="0"></div></div>
      <button id="elsewhere">x</button>
    `);
    const tree = host.querySelector<HTMLElement>("#tree");
    const get = (id: string) => host.querySelector(`#${id}`);
    expect(treeOwnsUndo(get("row"), tree)).toBe(true);
    expect(treeOwnsUndo(document.body, tree)).toBe(true);
    // Undo in the editor is the editor's; a button elsewhere is not the tree.
    expect(treeOwnsUndo(get("editor"), tree)).toBe(false);
    expect(treeOwnsUndo(get("elsewhere"), tree)).toBe(false);
  });
});
