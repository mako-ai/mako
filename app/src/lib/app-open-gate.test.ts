import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_OPEN_FALLBACK_MS,
  appTabReadsReady,
  armAppOpenGate,
  isAwaitingPublishedPaint,
  settleAppOpen,
  whenAppOpenSettled,
} from "./app-open-gate";

async function isSettled(): Promise<boolean> {
  let done = false;
  void whenAppOpenSettled().then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

afterEach(() => {
  settleAppOpen();
  vi.useRealTimers();
});

describe("the app-open gate", () => {
  it("lets every other page's boot reads through at once", async () => {
    armAppOpenGate("/c/abc123");
    expect(await isSettled()).toBe(true);
  });

  it("holds boot reads on /apps/<slug> until the app has loaded", async () => {
    armAppOpenGate("/apps/intl-renewals-dashboard");
    expect(await isSettled()).toBe(false);
    settleAppOpen();
    expect(await isSettled()).toBe(true);
  });

  it("never holds them past the fallback", async () => {
    vi.useFakeTimers();
    armAppOpenGate("/apps/intl-renewals-dashboard");
    expect(await isSettled()).toBe(false);
    vi.advanceTimersByTime(APP_OPEN_FALLBACK_MS);
    expect(await isSettled()).toBe(true);
  });
});

describe("an app tab's repo and box reads", () => {
  const loading = isAwaitingPublishedPaint({
    editing: false,
    publishedSha: "abc",
    pubLoaded: false,
    devRunning: false,
  });

  it("wait while the front tab's published app is loading", () => {
    expect(loading).toBe(true);
    expect(
      appTabReadsReady({
        isFrontTab: true,
        appKnown: true,
        awaitingPublishedPaint: loading,
        waitOver: false,
      }),
    ).toBe(false);
  });

  it("start once it has loaded, or the fallback fired", () => {
    const loaded = isAwaitingPublishedPaint({
      editing: false,
      publishedSha: "abc",
      pubLoaded: true,
      devRunning: false,
    });
    expect(
      appTabReadsReady({
        isFrontTab: true,
        appKnown: true,
        awaitingPublishedPaint: loaded,
        waitOver: false,
      }),
    ).toBe(true);
    expect(
      appTabReadsReady({
        isFrontTab: true,
        appKnown: true,
        awaitingPublishedPaint: loading,
        waitOver: true,
      }),
    ).toBe(true);
  });

  it("never run for a background tab; it reads when brought to the front", () => {
    expect(
      appTabReadsReady({
        isFrontTab: false,
        appKnown: true,
        awaitingPublishedPaint: false,
        waitOver: true,
      }),
    ).toBe(false);
  });

  it("start at once when nothing is loading: workbench, unpublished, dev serving", () => {
    for (const state of [
      {
        editing: true,
        publishedSha: "abc",
        pubLoaded: false,
        devRunning: false,
      },
      {
        editing: false,
        publishedSha: undefined,
        pubLoaded: false,
        devRunning: false,
      },
      {
        editing: false,
        publishedSha: "abc",
        pubLoaded: false,
        devRunning: true,
      },
    ]) {
      expect(isAwaitingPublishedPaint(state)).toBe(false);
      expect(
        appTabReadsReady({
          isFrontTab: true,
          appKnown: true,
          awaitingPublishedPaint: isAwaitingPublishedPaint(state),
          waitOver: false,
        }),
      ).toBe(true);
    }
  });

  it("wait for the app list before deciding", () => {
    expect(
      appTabReadsReady({
        isFrontTab: true,
        appKnown: false,
        awaitingPublishedPaint: false,
        waitOver: true,
      }),
    ).toBe(false);
  });
});
