import { describe, expect, it } from "vitest";
import {
  decideRemoteApply,
  type RemoteApplyDecisionInput,
} from "./remoteApplyGate";

function input(
  overrides: Partial<RemoteApplyDecisionInput>,
): RemoteApplyDecisionInput {
  return {
    tabExists: true,
    tabRevision: 1,
    entryRevision: 2,
    contentMatches: false,
    unsavedLocalEdits: false,
    ...overrides,
  };
}

describe("decideRemoteApply", () => {
  it("skips consoles that are not open in this window", () => {
    expect(decideRemoteApply(input({ tabExists: false }))).toBe("skip");
  });

  it("skips stale entries (tab already at or past the entry revision)", () => {
    expect(decideRemoteApply(input({ tabRevision: 2, entryRevision: 2 }))).toBe(
      "skip",
    );
    expect(decideRemoteApply(input({ tabRevision: 5, entryRevision: 2 }))).toBe(
      "skip",
    );
  });

  it("treats a never-synced tab as revision 0 so the first entry applies", () => {
    expect(
      decideRemoteApply(input({ tabRevision: undefined, entryRevision: 1 })),
    ).toBe("apply");
  });

  it("fast-forwards when local content already matches the server copy", () => {
    expect(decideRemoteApply(input({ contentMatches: true }))).toBe(
      "fast-forward",
    );
  });

  it("fast-forwards on matching content EVEN with unsaved local edits (the buffer may be ahead; revision base must advance so the pending autosave passes its guard)", () => {
    expect(
      decideRemoteApply(
        input({ contentMatches: true, unsavedLocalEdits: true }),
      ),
    ).toBe("fast-forward");
  });

  it("banners instead of silently merging when content diverges and the tab holds unsaved local edits", () => {
    expect(decideRemoteApply(input({ unsavedLocalEdits: true }))).toBe(
      "banner",
    );
  });

  it("applies divergent content to clean tabs", () => {
    expect(decideRemoteApply(input({}))).toBe("apply");
  });

  it("revision check wins over everything (no banner for stale entries even when dirty)", () => {
    expect(
      decideRemoteApply(
        input({ tabRevision: 9, entryRevision: 3, unsavedLocalEdits: true }),
      ),
    ).toBe("skip");
  });
});
