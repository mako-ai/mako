/**
 * A warm chunk with leases on makes the same 3 calls as one with leases off:
 * write the inputs, run the chunk, read the bounded output. No ping, and no
 * runtime or connector check, once a box is leased and known to be alive.
 *
 * Real BoxScheduler (in-memory store), real SandboxedConnector, real
 * sync-box and ensureBundle; the sandbox provider is a fake that records
 * every call. G1 (bench/g1) measured the 3 removed calls at 519 ms a chunk.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  calls: [] as string[],
  sandboxId: "sbx_1",
  gone: false,
}));

vi.mock("../../../apps/sandbox/provider", () => {
  const goneError = () =>
    Object.assign(new Error("Sandbox is probably not running anymore"), {
      name: "SandboxNotFoundError",
    });
  const protocol =
    [
      JSON.stringify({
        type: "RECORD",
        record: { stream: "rows", data: { id: "1" }, emitted_at: 0 },
      }),
      JSON.stringify({
        type: "STATE",
        state: {
          type: "STREAM",
          stream: { stream_descriptor: { name: "rows" }, stream_state: {} },
          mako: { hasMore: true },
        },
      }),
    ].join("\n") + "\n";
  const bytes = new TextEncoder().encode(protocol);
  const classify = (command: string): string => {
    if (command.includes("MAKO_CHUNK")) return "exec:chunk";
    if (command === "true") return "exec:ping";
    if (command.includes(".materialized")) return "exec:install-check";
    if (command.startsWith("rm -f")) return "exec:rm-result";
    return "exec:other";
  };
  const provider = {
    id: "e2b",
    supportsRunUsers: true,
    scratch: () => "/tmp",
    root: () => "/home/user/app",
    async exec(_ctx: unknown, command: string) {
      const kind = classify(command);
      box.calls.push(kind);
      if (box.gone) throw goneError();
      return {
        exitCode: 0,
        stdout:
          kind === "exec:chunk"
            ? `MAKO_CHUNK ${bytes.byteLength} 0\n`
            : kind === "exec:install-check"
              ? "yes\n"
              : "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
        truncated: false,
        sandboxId: box.sandboxId,
      };
    },
    async writeFiles() {
      box.calls.push("writeFiles");
      if (box.gone) throw goneError();
    },
    async writeFile() {
      box.calls.push("writeFile");
    },
    async readFile() {
      box.calls.push("readFile");
      if (box.gone) throw goneError();
      return bytes;
    },
    async destroySession() {
      box.calls.push("destroySession");
    },
    boxLifecycle: {
      async create() {
        box.calls.push("lifecycle:create");
      },
      async pause() {},
      async snapshot() {
        return null as unknown as string;
      },
      async deleteSnapshot() {},
      async countRunning() {
        return 0;
      },
    },
  };
  return {
    getSandboxProvider: () => provider,
    isSandboxGone: (error: unknown) =>
      (error as { name?: string })?.name === "SandboxNotFoundError",
  };
});

const sched = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./scheduler", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduler")>();
  return { ...actual, getBoxScheduler: () => sched.current };
});

vi.mock("../resolver", async importOriginal => {
  const actual = await importOriginal<typeof import("../resolver")>();
  return {
    ...actual,
    readConnectorFolder: vi.fn(
      async () =>
        new Map([["connector.ts", new TextEncoder().encode("export {}")]]),
    ),
  };
});

import { MemoryBoxSignals } from "./box-signals";
import { MemoryBoxStore } from "./box-store";
import { sandboxBoxProvider } from "./box-provider";
import { BOX_LEASE_DEFAULTS } from "./config";
import { BoxScheduler } from "./scheduler";
import { SandboxedConnector } from "../SandboxedConnector";
import type { LoadedConnector } from "../resolver";

class Acme extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "acme",
      runtime: "node",
      entry: "connector.ts",
      sha: "sha",
      sourceSha: "sha",
      spec: { mako: { entities: { rows: { label: "Rows" } } } },
      entities: ["rows"],
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }
}

const connector = () =>
  new Acme({
    _id: "665f00000000000000000001",
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws1",
    config: { api_key: "k" },
  } as never);

const chunk = (c: SandboxedConnector) =>
  c.fetchEntityChunk({ entity: "rows", onBatch: async () => undefined });

/** The calls a chunk awaits; the result file's rm runs off the critical path. */
const critical = (calls: string[]) =>
  calls.filter(call => call !== "exec:rm-result");

let store: MemoryBoxStore;

beforeEach(() => {
  process.env.CONNECTOR_BOX_LEASES = "true";
  box.calls.length = 0;
  box.gone = false;
  store = new MemoryBoxStore();
  sched.current = new BoxScheduler({
    store,
    signals: new MemoryBoxSignals(),
    provider: sandboxBoxProvider,
    config: { ...BOX_LEASE_DEFAULTS, snapshots: false },
  });
});

describe("a warm chunk with leases on", () => {
  it("makes exactly 3 calls: write inputs, run the chunk, read the output", async () => {
    const c = connector();
    await chunk(c); // cold: create, ping, prepare, install checks, chunk
    expect(box.calls).toContain("exec:ping");
    expect(box.calls).toContain("exec:install-check");

    box.calls.length = 0;
    await chunk(c);
    expect(critical(box.calls)).toEqual([
      "writeFiles",
      "exec:chunk",
      "readFile",
    ]);

    // And on the next chunk too: nothing builds up.
    box.calls.length = 0;
    await chunk(c);
    expect(critical(box.calls)).toEqual([
      "writeFiles",
      "exec:chunk",
      "readFile",
    ]);
  });

  it("holds for a second connector instance on the same box (another chunk of the flow)", async () => {
    await chunk(connector());
    box.calls.length = 0;
    await chunk(connector());
    expect(critical(box.calls)).toEqual([
      "writeFiles",
      "exec:chunk",
      "readFile",
    ]);
  });

  it("pings and re-checks the installs after a resume", async () => {
    const c = connector();
    await chunk(c);
    const [record] = [...store.boxes.values()];
    // The reaper paused it.
    await store.transition(
      record.boxId,
      { state: "idle" },
      { state: "paused" },
    );
    box.calls.length = 0;
    await chunk(c);
    expect(box.calls).toContain("exec:ping");
    expect(box.calls).toContain("exec:install-check");
  });

  it("fails the chunk when the warm box is gone, and the next chunk gets a new box", async () => {
    const c = connector();
    await chunk(c);
    const [first] = [...store.boxes.values()];
    box.gone = true;
    await expect(chunk(c)).rejects.toThrow(/not running/);
    expect(store.boxes.get(first.boxId)?.state).toBe("killed");

    box.gone = false;
    box.sandboxId = "sbx_2";
    box.calls.length = 0;
    await chunk(c);
    expect(box.calls).toContain("lifecycle:create");
    expect(
      [...store.boxes.values()].filter(b => b.state !== "killed"),
    ).toHaveLength(1);
  });
});
