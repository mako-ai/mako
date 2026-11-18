/**
 * src/test-support/mongo-memory.ts: MongoMemoryServer.create() retries a port
 * clash or a slow start, stops each failed instance, and throws anything else
 * at once. Runs on a fake server class, so it needs no mongod.
 */
import assert from "node:assert/strict";
import {
  MONGO_MEMORY_ATTEMPTS,
  MONGO_MEMORY_LAUNCH_TIMEOUT_MS,
  patchMongoMemoryServer,
} from "./test-support/mongo-memory";

function fakeServer(failures: string[]) {
  const seen = { started: 0, stopped: 0, opts: [] as unknown[] };
  class Fake {
    constructor(opts: unknown) {
      seen.opts.push(opts);
    }
    async start() {
      seen.started++;
      const msg = failures.shift();
      if (msg) throw new Error(msg);
    }
    async stop() {
      seen.stopped++;
      return true;
    }
    static async create(): Promise<Fake> {
      throw new Error("unpatched");
    }
  }
  patchMongoMemoryServer(Fake as never);
  return { Fake, seen };
}

async function main() {
  // A port clash, then a clean start: 2 attempts, the first instance stopped.
  {
    const { Fake, seen } = fakeServer(['Port "56770" already in use']);
    const server = await Fake.create();
    assert.ok(server instanceof Fake);
    assert.equal(seen.started, 2);
    assert.equal(seen.stopped, 1);
    const opts = seen.opts[0] as { instance: { launchTimeout: number } };
    assert.equal(opts.instance.launchTimeout, MONGO_MEMORY_LAUNCH_TIMEOUT_MS);
  }
  // Any other error is thrown on the first attempt.
  {
    const { Fake, seen } = fakeServer(["bad binary"]);
    await assert.rejects(() => Fake.create(), /bad binary/);
    assert.equal(seen.started, 1);
  }
  // A slow start every time gives up after MONGO_MEMORY_ATTEMPTS.
  {
    const slow = Array(MONGO_MEMORY_ATTEMPTS).fill(
      "Instance failed to start within 10000ms",
    );
    const { Fake, seen } = fakeServer(slow);
    await assert.rejects(() => Fake.create(), /failed to start within/);
    assert.equal(seen.started, MONGO_MEMORY_ATTEMPTS);
    assert.equal(seen.stopped, MONGO_MEMORY_ATTEMPTS);
  }
  // A caller's own launchTimeout wins.
  {
    const { Fake, seen } = fakeServer([]);
    await (Fake.create as (o: unknown) => Promise<unknown>)({
      instance: { launchTimeout: 5 },
    });
    assert.equal(
      (seen.opts[0] as { instance: { launchTimeout: number } }).instance
        .launchTimeout,
      5,
    );
  }
  console.info("test-mongo-memory: ok");
}

void main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
