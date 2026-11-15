import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ANCHOR,
  DEFAULT_AUTO_HIDE_MS,
  notify,
  useNotificationStore,
} from "./notificationStore";

const queue = () => useNotificationStore.getState().queue;

describe("notificationStore", () => {
  beforeEach(() => {
    useNotificationStore.setState({ queue: [] });
  });

  it("queues toasts with defaults and per-call options", () => {
    notify.success("Saved");
    notify.error("Nope", {
      autoHideDuration: 6000,
      anchorOrigin: { vertical: "bottom", horizontal: "center" },
      variant: "filled",
    });
    notify.message("Plain");

    expect(queue()).toHaveLength(3);
    expect(queue()[0]).toMatchObject({
      message: "Saved",
      severity: "success",
      autoHideDuration: DEFAULT_AUTO_HIDE_MS,
      anchorOrigin: DEFAULT_ANCHOR,
      variant: "standard",
      closing: false,
    });
    expect(queue()[1]).toMatchObject({
      severity: "error",
      autoHideDuration: 6000,
      anchorOrigin: { vertical: "bottom", horizontal: "center" },
      variant: "filled",
    });
    expect(queue()[2].severity).toBeUndefined();
  });

  it("keeps a toast open until dismissed when autoHideDuration is null", () => {
    notify.info("Sticky", { autoHideDuration: null });
    expect(queue()[0].autoHideDuration).toBeNull();
  });

  it("dedupes an identical toast that is visible or waiting", () => {
    const first = notify.success("Copied");
    notify.info("Other");
    const again = notify.success("Copied");
    expect(again).toBe(first);
    expect(queue().map(n => n.message)).toEqual(["Copied", "Other"]);
    // Same text, different severity, is a different toast.
    notify.error("Copied");
    expect(queue()).toHaveLength(3);
  });

  it("dedupes by explicit key", () => {
    const a = notify.info("Uploading 1/3", { key: "upload" });
    const b = notify.info("Uploading 2/3", { key: "upload" });
    expect(b).toBe(a);
    expect(queue()).toHaveLength(1);
  });

  it("dismiss marks the visible toast closing and drops a waiting one", () => {
    const visible = notify.success("One");
    const waiting = notify.success("Two");

    notify.dismiss(waiting);
    expect(queue().map(n => n.id)).toEqual([visible]);

    notify.dismiss(visible);
    expect(queue()[0].closing).toBe(true);

    // A closing toast no longer dedupes: the same message can be re-shown.
    const reshown = notify.success("One");
    expect(reshown).not.toBe(visible);

    useNotificationStore.getState().remove(visible);
    expect(queue().map(n => n.id)).toEqual([reshown]);
  });

  it("ignores dismiss of an unknown id", () => {
    notify.success("One");
    notify.dismiss(-1);
    expect(queue()).toHaveLength(1);
  });
});
