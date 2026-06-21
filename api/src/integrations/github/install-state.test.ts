import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInstallState, verifyInstallState } from "./install-state";

describe("github install-state", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a signed state for the same workspace + user", () => {
    const state = signInstallState({
      workspaceId: "ws1",
      userId: "user1",
      clientUrl: "http://localhost:5173",
    });
    const payload = verifyInstallState(state);
    expect(payload).toMatchObject({
      workspaceId: "ws1",
      userId: "user1",
      clientUrl: "http://localhost:5173",
    });
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const state = signInstallState({ workspaceId: "ws1", userId: "user1" });
    const [body, sig] = state.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    forged.workspaceId = "victim-ws";
    const forgedBody = Buffer.from(JSON.stringify(forged))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(verifyInstallState(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signInstallState({ workspaceId: "ws1", userId: "user1" });
    process.env.SESSION_SECRET = "another-secret";
    expect(verifyInstallState(state)).toBeNull();
  });

  it("rejects an expired state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const state = signInstallState({ workspaceId: "ws1", userId: "user1" });
    vi.setSystemTime(new Date("2026-01-01T00:16:00Z")); // > 15 min TTL
    expect(verifyInstallState(state)).toBeNull();
  });

  it("rejects empty / malformed input", () => {
    expect(verifyInstallState(undefined)).toBeNull();
    expect(verifyInstallState("")).toBeNull();
    expect(verifyInstallState("nodot")).toBeNull();
    expect(verifyInstallState(".sigonly")).toBeNull();
  });
});
