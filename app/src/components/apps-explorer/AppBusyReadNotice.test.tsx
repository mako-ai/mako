// @vitest-environment jsdom
/**
 * The notice for reads the server answered from the last commit because it
 * was busy (`busy: true`). It shows while either read is busy and clears on
 * the next live answer. A sleeping box (`offline` without `busy`) shows none.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const next = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));

vi.mock("../../api", () => ({
  api: { GET: vi.fn(async () => ({ data: next.body })) },
  unwrapBody: (r: { data?: unknown }) => r.data ?? {},
  toErrorMessage: (e: unknown) => String(e),
  toLoadError: (e: unknown, fallback: string) => ({
    message: e instanceof Error ? e.message : fallback,
  }),
  ApiError: class extends Error {},
}));
vi.mock("../../apps-runtime/shell", () => ({
  focusAppsTab: vi.fn(),
  focusAppsFileTab: vi.fn(),
  reconcileAppsTabs: vi.fn(),
}));

import { useAppsStore } from "../../store/appsStore";
import { AppBusyReadNotice, BUSY_READ_NOTICE } from "./AppBusyReadNotice";

const WS = "6846e6a01b05af0948070582";
const APP = "6a9411eb4c8b33609a65e665";
const status = { branch: "main", offline: true, changes: [], repoChanges: [] };

async function files(body: Record<string, unknown>) {
  next.body = { success: true, files: [], ...body };
  await act(() => useAppsStore.getState().fetchFiles(WS, APP));
}
async function fetchStatus(body: Record<string, unknown>) {
  next.body = { success: true, status, ...body };
  await act(() => useAppsStore.getState().fetchStatus(WS, APP));
}
const shown = () => screen.queryByText(BUSY_READ_NOTICE) !== null;

beforeEach(() => {
  useAppsStore.setState(s => {
    s.busyReadByApp = {};
  });
});
afterEach(cleanup);

describe("AppBusyReadNotice", () => {
  it("shows nothing for a live read or a sleeping box", async () => {
    render(<AppBusyReadNotice appId={APP} />);
    await files({ offline: false });
    await fetchStatus({ busy: false });
    expect(shown()).toBe(false);
    // offline without busy: the box sleeps, nothing is wrong.
    await files({ offline: true });
    expect(shown()).toBe(false);
  });

  it("shows on a busy read and clears on the next live one", async () => {
    render(<AppBusyReadNotice appId={APP} />);
    await files({ offline: true, busy: true });
    expect(shown()).toBe(true);
    expect(screen.getByRole("alert").className).toContain("Info");

    await fetchStatus({ busy: true });
    await files({ offline: false });
    // Status is still the last commit.
    expect(shown()).toBe(true);

    await fetchStatus({ busy: false });
    expect(shown()).toBe(false);
    expect(useAppsStore.getState().busyReadByApp[APP]).toBeUndefined();
  });

  it("only labels the app it is given", async () => {
    render(<AppBusyReadNotice appId="another-app" />);
    await files({ offline: true, busy: true });
    expect(shown()).toBe(false);
  });
});
