import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPinnedAgentPool,
  loadUndici,
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

async function main() {
  await testTwoCallsReuseOneSocket();
  await testAgentKeyedByHostPortAndIp();
  await testLeastRecentlyUsedAgentIsEvicted();
  await testPooledAgentStillRefusesPrivateIp();
}

main().catch((error: unknown) => {
  throw error;
});
