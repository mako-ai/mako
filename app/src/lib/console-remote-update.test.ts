import { describe, expect, it } from "vitest";
import { remoteUpdateMessage } from "./console-remote-update";

describe("remoteUpdateMessage", () => {
  it("says 'by' (the banner read 'updated another collaborator')", () => {
    expect(
      remoteUpdateMessage(
        { kind: "updated", draftRevision: 2, updatedBy: "u2" },
        "u1",
      ),
    ).toBe(
      "This console was updated by another collaborator — your unsaved changes are based on an older copy.",
    );
  });

  it("never calls the person's own change 'another collaborator'", () => {
    expect(
      remoteUpdateMessage(
        { kind: "updated", draftRevision: 2, updatedBy: "u1" },
        "u1",
      ),
    ).toMatch(/^This console was updated in another window/);
  });

  it("names the agent, and says 'elsewhere' when nobody is known", () => {
    expect(
      remoteUpdateMessage(
        { kind: "updated", draftRevision: 2, updatedBy: "agent" },
        "u1",
      ),
    ).toMatch(/updated by the agent/);
    expect(remoteUpdateMessage({ kind: "updated", draftRevision: 2 })).toMatch(
      /updated elsewhere/,
    );
  });

  it("words a deletion the same way", () => {
    expect(
      remoteUpdateMessage(
        { kind: "deleted", draftRevision: 9, updatedBy: "u2" },
        "u1",
      ),
    ).toBe("This console was deleted by another collaborator.");
    expect(
      remoteUpdateMessage(
        { kind: "deleted", draftRevision: 9, updatedBy: "u1" },
        "u1",
      ),
    ).toBe("This console was deleted in another window.");
  });

  it("says a git push, even when the person pushed it themselves", () => {
    expect(
      remoteUpdateMessage(
        { kind: "updated", draftRevision: 3, updatedBy: "u1", via: "git" },
        "u1",
      ),
    ).toBe(
      "This console was updated from a git push — your unsaved changes are based on an older copy.",
    );
    expect(
      remoteUpdateMessage(
        { kind: "deleted", draftRevision: 9, updatedBy: "u2", via: "git" },
        "u1",
      ),
    ).toBe("This console was deleted by a git push.");
  });
});
