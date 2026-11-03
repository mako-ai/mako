/**
 * realtime-channel registry: typed dispatch, keyed (HMR-idempotent)
 * registration, the shared clientId echo guard, and handler error
 * isolation.
 */
import { describe, expect, it, vi } from "vitest";

import { realtimeClientId } from "../../lib/realtime-client-id";
import {
  dispatchRealtimeEvent,
  isOwnEcho,
  onRealtimeEvent,
  type RealtimeEvent,
} from "./realtime-channel";

const ctx = { workspaceId: "ws1", currentUserId: "u1" };

const notebookEvent = (clientId?: string): RealtimeEvent => ({
  type: "notebook.updated",
  notebookId: "n1",
  version: 2,
  updatedBy: "u2",
  clientId,
  origin: "save",
});

describe("realtime-channel", () => {
  it("routes an event to its type's handlers with the dispatch context", () => {
    const seen = vi.fn();
    onRealtimeEvent("notebook.updated", "t-route", seen);
    dispatchRealtimeEvent(notebookEvent(), ctx);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: "n1" }),
      ctx,
    );
    // Other types don't reach it.
    dispatchRealtimeEvent({ type: "notebook.tree.updated" }, ctx);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("re-registering the same (type, key) replaces, not stacks", () => {
    const first = vi.fn();
    const second = vi.fn();
    onRealtimeEvent("notebook.updated", "t-replace", first);
    onRealtimeEvent("notebook.updated", "t-replace", second);
    dispatchRealtimeEvent(notebookEvent(), ctx);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("suppressOwnEcho drops this window's own writes only", () => {
    const seen = vi.fn();
    onRealtimeEvent("notebook.updated", "t-echo", seen, {
      suppressOwnEcho: true,
    });
    dispatchRealtimeEvent(notebookEvent(realtimeClientId), ctx);
    expect(seen).not.toHaveBeenCalled();
    dispatchRealtimeEvent(notebookEvent("someone-else"), ctx);
    expect(seen).toHaveBeenCalledTimes(1);
    dispatchRealtimeEvent(notebookEvent(undefined), ctx);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("a throwing handler does not starve the others", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const survivor = vi.fn();
    onRealtimeEvent("notebook.updated", "t-throws", () => {
      throw new Error("boom");
    });
    onRealtimeEvent("notebook.updated", "t-survives", survivor);
    dispatchRealtimeEvent(notebookEvent(), ctx);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("isOwnEcho matches only this window's clientId", () => {
    expect(isOwnEcho({ clientId: realtimeClientId })).toBe(true);
    expect(isOwnEcho({ clientId: "other" })).toBe(false);
    expect(isOwnEcho({})).toBe(false);
  });
});
