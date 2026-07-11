import { describe, expect, it, vi } from "vitest";
import type { ConsoleTab } from "../store/lib/types";
import {
  confirmAppV2FileTabClose,
  confirmAppV2RemoteLoad,
} from "./close-guard";

const tab = (isDirty: boolean): ConsoleTab => ({
  id: "app-v2-file:project-1:src/App.tsx",
  title: "App.tsx",
  content: "",
  isSaved: true,
  kind: "app-v2-file",
  isDirty,
});

describe("Apps v2 file close guard", () => {
  it("blocks dirty file cleanup when discard is not confirmed", () => {
    const confirm = vi.fn(() => false);
    expect(confirmAppV2FileTabClose(tab(true), confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      'Discard unsaved changes to "App.tsx"?',
    );
  });

  it("does not prompt for pristine Apps v2 files", () => {
    const confirm = vi.fn(() => false);
    expect(confirmAppV2FileTabClose(tab(false), confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels loading a remote version over dirty local edits", () => {
    const confirm = vi.fn(() => false);
    expect(confirmAppV2RemoteLoad(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "Load the remote version and discard your unsaved local edits?",
    );
  });
});
