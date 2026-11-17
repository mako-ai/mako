import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPinnedAgentPool,
  loadUndici,
  retryClosedSocketOnce,
  SafeFetchError,
  safeRequest,
} from "./safe-fetch.service";

/** A local HTTP server that counts the TCP connections it accepts. */
async function countingServer(): Promise<{
  server: Server;
  port: number;
  connections: () => number;
  hosts: string[];
}> {
  let connections = 0;
  const hosts: string[] = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host ?? "");
    res.end("ok");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, connections: () => connections, hosts };
}

/** Tests reach 127.0.0.1, which the production check refuses. */
const allowLoopback = (ip: string) => {
  if (ip !== "127.0.0.1") throw new SafeFetchError(`not loopback: ${ip}`);
};

async function testTwoCallsReuseOneSocket() {
  const undici = await loadUndici();
  const pool = createPinnedAgentPool(undici, { assertIp: allowLoopback });
  const local = await countingServer();
  try {
    const url = new URL(`http://service.test:${local.port}/a`);
    for (let i = 0; i < 2; i++) {
      const agent = pool.get(url, "127.0.0.1", 4);
      const response = await undici.fetch(url, { dispatcher: agent });
      assert.equal(await response.text(), "ok");
      // A real caller does other work between calls; back to back in one
      // tick, undici has not yet returned the socket to the pool.
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(local.connections(), 1, "the second call opened a socket");
    assert.equal(pool.size, 1);
    // The agent pinned to 127.0.0.1 reached it for a name that resolves
    // nowhere, and sent that name as Host.
    assert.deepEqual(local.hosts, [
      `service.test:${local.port}`,
      `service.test:${local.port}`,
    ]);
  } finally {
    await pool.close();
    local.server.close();
  }
}

async function testAgentKeyedByHostPortAndIp() {
  const undici = await loadUndici();
  const pool = createPinnedAgentPool(undici, { assertIp: () => undefined });
  try {
    const a = new URL("https://probo.example.com/x");
    const first = pool.get(a, "93.184.216.34", 4);
    assert.equal(
      pool.get(new URL("https://probo.example.com/y"), "93.184.216.34", 4),
      first,
    );
    // DNS answered another IP: a new agent, pinned to it.
    assert.notEqual(pool.get(a, "93.184.216.35", 4), first);
    // Another host on the same IP, another port, another scheme: never shared.
    assert.notEqual(
      pool.get(new URL("https://inbox.example.com/x"), "93.184.216.34", 4),
      first,
    );
    assert.notEqual(
      pool.get(new URL("https://probo.example.com:8443/x"), "93.184.216.34", 4),
      first,
    );
    assert.notEqual(
      pool.get(new URL("http://probo.example.com/x"), "93.184.216.34", 4),
      first,
    );
    assert.equal(pool.size, 5);
  } finally {
    await pool.close();
  }
}

async function testLeastRecentlyUsedAgentIsEvicted() {
  const undici = await loadUndici();
  const pool = createPinnedAgentPool(undici, {
    assertIp: () => undefined,
    maxAgents: 2,
  });
  try {
    const url = new URL("https://service.example.com/");
    const one = pool.get(url, "93.184.216.1", 4);
    pool.get(url, "93.184.216.2", 4);
    assert.equal(pool.get(url, "93.184.216.1", 4), one); // now most recent
    pool.get(url, "93.184.216.3", 4); // evicts .2
    assert.equal(pool.size, 2);
    assert.equal(pool.get(url, "93.184.216.1", 4), one);
  } finally {
    await pool.close();
  }
}

async function testPooledAgentStillRefusesPrivateIp() {
  const undici = await loadUndici();
  // The production check: a pooled agent pinned to a private IP never connects.
  const pool = createPinnedAgentPool(undici);
  const local = await countingServer();
  try {
    const url = new URL(`http://service.test:${local.port}/`);
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () => undici.fetch(url, { dispatcher: pool.get(url, "127.0.0.1", 4) }),
        (error: unknown) =>
          (error as { cause?: unknown }).cause instanceof SafeFetchError,
      );
    }
    assert.equal(local.connections(), 0);
  } finally {
    await pool.close();
    local.server.close();
  }
  await assert.rejects(
    () => safeRequest("http://10.0.0.1/", { method: "GET", headers: {} }),
    SafeFetchError,
  );
  await assert.rejects(
    () => safeRequest("http://127.0.0.1/", { method: "GET", headers: {} }),
    SafeFetchError,
  );
  await assert.rejects(
    () => safeRequest("http://localhost/", { method: "GET", headers: {} }),
    SafeFetchError,
  );
}

async function testSocketsPerAgentAreCapped() {
  const undici = await loadUndici();
  const pool = createPinnedAgentPool(undici, {
    assertIp: allowLoopback,
    maxSockets: 2,
  });
  let connections = 0;
  // Answers after 30 ms, so 6 calls at once all want a socket.
  const server = createServer((_req, res) => {
    setTimeout(() => res.end("ok"), 30);
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const url = new URL(`http://service.test:${port}/`);
    const bodies = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const response = await undici.fetch(url, {
          dispatcher: pool.get(url, "127.0.0.1", 4),
        });
        return response.text();
      }),
    );
    assert.deepEqual(bodies, Array(6).fill("ok"));
    assert.equal(connections, 2, "6 calls at once opened more than 2 sockets");
  } finally {
    await pool.close();
    server.close();
  }
}

/**
 * A server that answers the first request on a socket and destroys the
 * socket at the second: what a caller sees when it reuses a kept-alive
 * socket the service has already dropped.
 */
async function dropsReusedSockets(): Promise<{
  server: Server;
  port: number;
  requests: string[];
}> {
  const seen = new WeakMap<object, number>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.method ?? "");
    const count = (seen.get(req.socket) ?? 0) + 1;
    seen.set(req.socket, count);
    if (count > 1) {
      req.socket.destroy();
      return;
    }
    res.end("ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, requests };
}

async function testClosedSocketRetriesReadsOnly() {
  const undici = await loadUndici();
  const pool = createPinnedAgentPool(undici, { assertIp: allowLoopback });
  const local = await dropsReusedSockets();
  const never = new AbortController().signal;
  try {
    const url = new URL(`http://service.test:${local.port}/`);
    const call = (method: string) =>
      retryClosedSocketOnce(method, never, async () => {
        const response = await undici.fetch(url, {
          method,
          dispatcher: pool.get(url, "127.0.0.1", 4),
        });
        return response.text();
      });
    const pause = () => new Promise(resolve => setTimeout(resolve, 5));

    // GET: the second call reuses the socket, the server drops it, and the
    // call is sent once more on a new socket.
    assert.equal(await call("GET"), "ok");
    await pause();
    assert.equal(await call("GET"), "ok");
    assert.deepEqual(local.requests, ["GET", "GET", "GET"]);

    // POST on the reused socket: fails, and is not sent a second time.
    await pause();
    local.requests.length = 0;
    await assert.rejects(() => call("POST"));
    assert.deepEqual(local.requests, ["POST"]);
  } finally {
    await pool.close();
    local.server.close();
  }
}

async function testRetryOnlyForClosedSocketsAndWaitingCallers() {
  const closed = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  const failing = (error: unknown) => {
    let attempts = 0;
    return {
      attempt: async () => {
        attempts += 1;
        throw error;
      },
      attempts: () => attempts,
    };
  };
  const never = new AbortController().signal;

  // A closed socket on a GET: 2 attempts, and the second error is thrown.
  const get = failing(closed);
  await assert.rejects(() => retryClosedSocketOnce("get", never, get.attempt));
  assert.equal(get.attempts(), 2);

  // Any other error (a blocked address, a timeout): 1 attempt.
  const blocked = failing(new SafeFetchError("Blocked IP range"));
  await assert.rejects(
    () => retryClosedSocketOnce("GET", never, blocked.attempt),
    SafeFetchError,
  );
  assert.equal(blocked.attempts(), 1);

  // Writes, and PUT and DELETE with them: 1 attempt.
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const write = failing(closed);
    await assert.rejects(() =>
      retryClosedSocketOnce(method, never, write.attempt),
    );
    assert.equal(write.attempts(), 1, method);
  }

  // The caller hung up: 1 attempt.
  const aborted = new AbortController();
  aborted.abort();
  const gone = failing(closed);
  await assert.rejects(() =>
    retryClosedSocketOnce("GET", aborted.signal, gone.attempt),
  );
  assert.equal(gone.attempts(), 1);
}

async function main() {
  await testTwoCallsReuseOneSocket();
  await testAgentKeyedByHostPortAndIp();
  await testLeastRecentlyUsedAgentIsEvicted();
  await testPooledAgentStillRefusesPrivateIp();
  await testSocketsPerAgentAreCapped();
  await testClosedSocketRetriesReadsOnly();
  await testRetryOnlyForClosedSocketsAndWaitingCallers();
}

main().catch((error: unknown) => {
  throw error;
});
