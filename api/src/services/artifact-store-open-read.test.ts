/**
 * One-round-trip reads of a stored object (published app assets).
 *
 * The GCS path is driven with a stand-in for `File.createReadStream()`: a
 * PassThrough that sends its request only on the first read, then reports
 * the HTTP response and, for a failure, an error — the library's order.
 */
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getArtifactStore, openGcsRead } from "./artifact-store.service";

function fakeGcsStream(answer: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  const stream = new PassThrough();
  const requested = vi.fn();
  let sent = false;
  const read = stream._read.bind(stream);
  stream._read = size => {
    if (!sent) {
      sent = true;
      requested();
      setImmediate(() => {
        stream.emit("response", {
          statusCode: answer.status,
          headers: answer.headers ?? {},
        });
        if (answer.status >= 400) {
          const error = Object.assign(new Error(`HTTP ${answer.status}`), {
            code: answer.status,
          });
          setImmediate(() => stream.destroy(error));
        } else {
          stream.end(answer.body ?? "");
        }
      });
    }
    read(size);
  };
  return { stream, requested };
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe("openGcsRead", () => {
  it("starts the download and hands over the body with its size", async () => {
    const { stream, requested } = fakeGcsStream({
      status: 200,
      headers: { "content-length": "5" },
      body: "hello",
    });
    const opened = await openGcsRead(stream);
    expect(requested).toHaveBeenCalledTimes(1);
    expect(opened?.size).toBe(5);
    expect(await text(opened!.stream)).toBe("hello");
  });

  it("is null for a missing object, so the route answers 404", async () => {
    const { stream } = fakeGcsStream({ status: 404 });
    expect(await openGcsRead(stream)).toBeNull();
  });

  it("rejects any other failure instead of calling it missing", async () => {
    const { stream } = fakeGcsStream({ status: 403 });
    await expect(openGcsRead(stream)).rejects.toThrow("HTTP 403");
  });

  it("sends no size for a body the library decompresses", async () => {
    const { stream } = fakeGcsStream({
      status: 200,
      headers: { "content-length": "3", "content-encoding": "gzip" },
      body: "decompressed",
    });
    const opened = await openGcsRead(stream);
    expect(opened?.size).toBeNull();
    expect(await text(opened!.stream)).toBe("decompressed");
  });
});

describe("filesystem store openRead", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mako-open-read-"));
    vi.stubEnv("DASHBOARD_ARTIFACT_STORE", "filesystem");
    vi.stubEnv("DASHBOARD_ARTIFACT_DIR", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("opens a file with its size, and is null when it is missing", async () => {
    await mkdir(path.join(root, "a"), { recursive: true });
    await writeFile(path.join(root, "a", "index.html"), "<html></html>");
    const store = getArtifactStore();
    const opened = await store.openRead!("a/index.html");
    expect(opened?.size).toBe(13);
    expect(await text(opened!.stream)).toBe("<html></html>");
    expect(await store.openRead!("a/missing.js")).toBeNull();
    expect(await store.openRead!("a")).toBeNull();
  });
});
