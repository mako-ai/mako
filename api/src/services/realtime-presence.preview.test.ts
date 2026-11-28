import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { sessionManager } from "../auth/session";
import { loggingMiddleware } from "../logging";
import { realtimeRoutes } from "../routes/realtime";
import { ensureTestWorkspace, setupPgTestDb } from "../test-support/pg-test";
import { hasAttachedClients } from "./realtime-presence.service";

interface ApiInstance {
  origin: string;
  cookie: string;
}

async function runApiInstance(workspaceId: string) {
  const mongoUrl = process.env.DATABASE_URL;
  assert.ok(mongoUrl && mongoUrl.startsWith("mongodb://127.0.0.1:"));
  await mongoose.connect(mongoUrl);
  const pg = await setupPgTestDb();
  const workspace = await ensureTestWorkspace(pg.db, {
    id: workspaceId,
    ownerUserId: "preview-presence-owner",
  });
  assert.ok(workspace.ownerUserId);
  const session = await sessionManager.createSession(workspace.ownerUserId);
  const app = new OpenAPIHono();
  app.use("*", loggingMiddleware({}));
  app.route("/api/workspaces/:workspaceId/realtime", realtimeRoutes);
  app.get("/fixture/attached/:workspaceId", async c =>
    c.json(await hasAttachedClients(c.req.param("workspaceId"))),
  );
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, address => {
    process.send?.({
      origin: `http://127.0.0.1:${address.port}`,
      cookie: `${sessionManager.sessionCookieName}=${session.id}`,
    } satisfies ApiInstance);
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  failure: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail(failure);
}

function eventReader(stream: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "";
  return async (event: string) => {
    const marker = `event: ${event}\n`;
    while (!pending.includes(marker)) {
      const { done, value } = await stream.read();
      assert.equal(done, false, `Stream ended before ${event}`);
      pending += decoder.decode(value, { stream: true });
    }
    pending = pending.slice(pending.indexOf(marker) + marker.length);
  };
}

async function startInstance(
  mongoUrl: string,
  workspaceId: string,
  serviceName: string,
  children: ChildProcess[],
  signal: AbortSignal,
): Promise<ApiInstance> {
  const child = fork(__filename, ["--preview-api", workspaceId], {
    execArgv: ["--max-old-space-size=4096", "--import", "tsx"],
    env: {
      ...process.env,
      K_SERVICE: serviceName,
      DATABASE_URL: mongoUrl,
      REDIS_URL: "",
      POSTGRES_URL: "",
      ENCRYPTION_KEY: "0".repeat(64),
    },
  });
  children.push(child);
  const [instance] = await Promise.race([
    once(child, "message", { signal }),
    once(child, "exit", { signal }).then(([code]) => {
      throw new Error(`Preview API fixture exited before listening (${code})`);
    }),
  ]);
  return instance as ApiInstance;
}

async function openStream(
  instance: ApiInstance,
  workspaceId: string,
  signal: AbortSignal,
) {
  const response = await fetch(
    `${instance.origin}/api/workspaces/${workspaceId}/realtime?clientId=fixture`,
    { headers: { cookie: instance.cookie }, signal },
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  assert.ok(response.body);
  return response.body.getReader();
}

if (process.argv[2] === "--preview-api") {
  void runApiInstance(process.argv[3]);
} else {
  void test(
    "Redis-less API instances share TTL-backed SSE presence only with their own PR",
    { timeout: 75_000 },
    async ({ signal }) => {
      const mongo = await MongoMemoryServer.create();
      const mongoUrl = mongo.getUri("staging");
      const inspector = new MongoClient(mongoUrl);
      const database = inspector.db();
      const presence = database.collection<{
        workspaceId: ObjectId;
        clientId: string;
        userId: string;
        lastSeenAt: Date;
      }>("realtime_presence");
      const children: ChildProcess[] = [];
      try {
        await database
          .admin()
          .command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
        const workspaceId = new ObjectId();
        const id = workspaceId.toHexString();
        const filter = { workspaceId, clientId: "pr:1580:fixture" };
        const otherFilter = { workspaceId, clientId: "pr:1581:fixture" };
        await presence.insertOne({
          workspaceId,
          clientId: "unscoped-legacy-tab",
          userId: "fixture",
          lastSeenAt: new Date(),
        });
        const [writer, reader, otherPreview] = await Promise.all([
          startInstance(mongoUrl, id, "mako-pr-1580", children, signal),
          startInstance(mongoUrl, id, "mako-pr-1580", children, signal),
          startInstance(mongoUrl, id, "mako-pr-1581", children, signal),
        ]);
        assert.equal(
          new Set([writer.origin, reader.origin, otherPreview.origin]).size,
          3,
        );
        const attached = async (instance = reader, workspace = id) => {
          const response = await fetch(
            `${instance.origin}/fixture/attached/${workspace}`,
            { signal: AbortSignal.timeout(5000) },
          );
          assert.equal(response.status, 200);
          return (await response.json()) === true;
        };
        assert.equal(await attached(), false);
        assert.equal(await attached(otherPreview), false);

        const stream = await openStream(writer, id, signal);
        const waitForEvent = eventReader(stream);
        let otherStream: typeof stream | undefined;
        try {
          try {
            await waitForEvent("hello");
            await waitFor(
              () => attached(),
              "Second instance never saw the tab",
            );
            assert.equal(
              await attached(reader, new ObjectId().toHexString()),
              false,
            );
            assert.equal(await attached(otherPreview), false);
            const initial = await presence.findOne(filter);
            assert.ok(initial);

            otherStream = await openStream(otherPreview, id, signal);
            await waitFor(
              () => attached(otherPreview),
              "Other PR never saw its own tab",
            );
            assert.ok(await presence.findOne(otherFilter));
            await otherStream.cancel();
            otherStream = undefined;
            await waitFor(
              async () => !(await attached(otherPreview)),
              "Other PR still saw its disconnected tab",
            );
            assert.equal(await presence.findOne(otherFilter), null);
            assert.equal(await attached(), true);
            otherStream = await openStream(otherPreview, id, signal);
            await waitFor(
              () => attached(otherPreview),
              "Other PR never saw its reconnected tab",
            );

            await waitFor(
              async () =>
                (await presence.indexes()).some(
                  index =>
                    index.key.lastSeenAt === 1 &&
                    index.expireAfterSeconds === 90,
                ),
              "Preview presence did not create its 90-second TTL index",
            );
            const stale = {
              workspaceId: new ObjectId(),
              clientId: "pr:1580:stale",
            };
            await presence.insertOne({
              ...stale,
              userId: "fixture",
              lastSeenAt: new Date(Date.now() - 70_000),
            });
            assert.equal(
              await attached(reader, stale.workspaceId.toHexString()),
              false,
            );
            assert.ok(
              await presence.findOne(stale),
              "TTL keeps still-unexpired rows",
            );
            await presence.updateOne(stale, {
              $set: { lastSeenAt: new Date(Date.now() - 91_000) },
            });
            await waitFor(
              async () => (await presence.findOne(stale)) === null,
              "Mongo TTL monitor did not remove the expired tab",
              10_000,
            );

            await waitForEvent("ping");
            await waitFor(async () => {
              const row = await presence.findOne(filter);
              return row !== null && row.lastSeenAt > initial.lastSeenAt;
            }, "Heartbeat never renewed the shared Mongo row");
            assert.equal(await attached(), true);
          } finally {
            await stream.cancel();
          }
          await waitFor(
            async () => !(await attached()),
            "Second instance still saw the disconnected tab",
          );
          assert.equal(await presence.findOne(filter), null);
          assert.equal(await attached(otherPreview), true);
        } finally {
          await otherStream?.cancel();
        }
        await waitFor(
          async () => !(await attached(otherPreview)),
          "Other PR still saw its disconnected tab",
        );
        assert.equal(await presence.findOne(otherFilter), null);
      } finally {
        await Promise.all(
          children.map(async child => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, "exit");
            child.kill();
            await exited;
          }),
        );
        await inspector.close();
        await mongo.stop();
      }
    },
  );
}
