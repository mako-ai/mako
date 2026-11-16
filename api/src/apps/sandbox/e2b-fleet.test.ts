/**
 * The fleet view never touches the wrong box: connector keys are ignored, and
 * settling a box by id connects to that box only. The e2b SDK is a mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  return {
    run,
    list: vi.fn(),
    connect: vi.fn(async (id: string) => ({
      sandboxId: id,
      commands: { run },
    })),
    create: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
  };
});
vi.mock("e2b", () => ({
  Sandbox: {
    list: sdk.list,
    connect: sdk.connect,
    create: sdk.create,
    kill: sdk.kill,
    pause: sdk.pause,
  },
}));

import { listAppBoxes, openAppBoxById } from "./e2b-fleet";

const WS = "6846e6a01b05af0948070582";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.E2B_API_KEY = "test-key";
});

function page(items: Array<{ id: string; key?: string }>) {
  let done = false;
  return {
    get hasNext() {
      return !done;
    },
    nextItems: async () => {
      done = true;
      return items.map(i => ({
        sandboxId: i.id,
        metadata: i.key ? { makoAppsSessionKey: i.key } : {},
        state: "paused",
        startedAt: new Date(0),
        cpuCount: 2,
        memoryMB: 2048,
      }));
    },
  };
}

describe("listAppBoxes", () => {
  it("keeps person and publish session keys, ignores connector and untagged boxes", async () => {
    sdk.list.mockReturnValue(
      page([
        { id: "a", key: `${WS}:6846e6a01b05af0948070999` },
        { id: "b", key: `${WS}:publish` },
        { id: "c", key: `connector-sync:${WS}` },
        { id: "d", key: `connector-build:${WS}` },
        { id: "e" },
      ]),
    );
    const boxes = await listAppBoxes();
    expect(boxes.map(b => b.sandboxId)).toEqual(["a", "b"]);
  });
});

describe("openAppBoxById", () => {
  it("connects to that exact box and never lists, creates or kills", async () => {
    const run = await openAppBoxById("sbx-42");
    await run("git status");
    expect(sdk.connect).toHaveBeenCalledWith("sbx-42", expect.anything());
    expect(sdk.run).toHaveBeenCalledWith(
      "git status",
      expect.objectContaining({ user: "user" }),
    );
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.kill).not.toHaveBeenCalled();
  });

  it("throws when the box will not connect, still creating nothing", async () => {
    sdk.connect.mockRejectedValueOnce(
      new Error("Paused sandbox sbx-9 not found"),
    );
    await expect(openAppBoxById("sbx-9")).rejects.toThrow(/not found/);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.kill).not.toHaveBeenCalled();
  });

  it("turns a non-zero exit into a result, not a throw", async () => {
    sdk.run.mockRejectedValueOnce(
      Object.assign(new Error("exit 1"), { exitCode: 1, stderr: "boom" }),
    );
    const run = await openAppBoxById("sbx-1");
    expect(await run("false")).toMatchObject({ exitCode: 1, stderr: "boom" });
  });
});
