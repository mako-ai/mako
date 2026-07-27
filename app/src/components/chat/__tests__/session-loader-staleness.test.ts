import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { isPersistedSnapshotStale } from "../hooks/useChatSessionLoader";

type RawMessages = Parameters<typeof isPersistedSnapshotStale>[0];

function user(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

function assistant(parts: Array<Record<string, unknown>>) {
  return { role: "assistant", parts };
}

function tool(state: string, toolCallId = "call-1") {
  return {
    type: "tool-create_dashboard",
    toolCallId,
    state,
    input: { title: "X" },
  };
}

const asUi = (msgs: RawMessages) => msgs as unknown as UIMessage[];

describe("isPersistedSnapshotStale (reload-before-replay guard)", () => {
  it("not stale when memory is empty (cold open)", () => {
    expect(isPersistedSnapshotStale([user("hi")], asUi([]))).toBe(false);
  });

  it("stale when the snapshot has fewer messages than memory", () => {
    const memory = [user("hi"), assistant([tool("output-available")])];
    expect(isPersistedSnapshotStale([user("hi")], asUi(memory))).toBe(true);
  });

  it("not stale when the snapshot has more messages (server ahead)", () => {
    const persisted = [user("hi"), assistant([tool("output-available")])];
    expect(isPersistedSnapshotStale(persisted, asUi([user("hi")]))).toBe(false);
  });

  it("stale when a tool settled in memory is still pending in the snapshot", () => {
    // The segment-boundary race: create_dashboard settled locally via
    // addToolOutput, but the continuation save hasn't landed server-side.
    const persisted = [user("hi"), assistant([tool("input-available")])];
    const memory = [user("hi"), assistant([tool("output-available")])];
    expect(isPersistedSnapshotStale(persisted, asUi(memory))).toBe(true);
  });

  it("stale when the snapshot is missing trailing parts of the last message", () => {
    const persisted = [user("hi"), assistant([tool("output-available")])];
    const memory = [
      user("hi"),
      assistant([
        tool("output-available"),
        { type: "text", text: "All done." },
      ]),
    ];
    expect(isPersistedSnapshotStale(persisted, asUi(memory))).toBe(true);
  });

  it("not stale when snapshot and memory agree", () => {
    const parts = [tool("output-available"), { type: "text", text: "Done." }];
    expect(
      isPersistedSnapshotStale(
        [user("hi"), assistant(parts)],
        asUi([user("hi"), assistant(parts)]),
      ),
    ).toBe(false);
  });

  it("stale when Local ACP optimistic turn is ahead of an empty History fetch", () => {
    const memory = [
      user("build me an app"),
      assistant([{ type: "text", text: "" }]),
    ];
    expect(isPersistedSnapshotStale([], asUi(memory))).toBe(true);
  });

  it("stale when equal-length snapshot has a different newest user text", () => {
    const persisted = [user("old"), assistant([{ type: "text", text: "ok" }])];
    const memory = [
      user("new question"),
      assistant([{ type: "text", text: "" }]),
    ];
    expect(isPersistedSnapshotStale(persisted, asUi(memory))).toBe(true);
  });

  it("not stale when the snapshot has MORE parts (server ahead mid-replay)", () => {
    const persisted = [
      user("hi"),
      assistant([tool("output-available"), { type: "text", text: "Done." }]),
    ];
    const memory = [user("hi"), assistant([tool("output-available")])];
    expect(isPersistedSnapshotStale(persisted, asUi(memory))).toBe(false);
  });
});
