/* eslint-disable no-console, no-process-exit */
/**
 * Unit tests for the notebook working-tree store — create/list/get/update/
 * remove round-trip against a temp NOTEBOOK_WORKDIR, plus path-traversal and
 * workspace-isolation guards.
 *
 * Run with: tsx src/notebooks/notebook-workingtree.service.test.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const WORKDIR = path.join(os.tmpdir(), `mako-notebooks-test-${randomUUID()}`);
process.env.NOTEBOOK_WORKDIR = WORKDIR;

// Import AFTER setting the env — the service reads NOTEBOOK_WORKDIR lazily per
// call, but keep this ordering explicit for clarity.
import { notebookWorkingTreeService as svc } from "./notebook-workingtree.service";

const WS = "651234567890abcdef123456"; // ObjectId-shaped
const WS2 = "651234567890abcdef999999";

async function testCreateGetListRoundTrip() {
  const created = await svc.create(WS, { name: "Revenue analysis" });
  assert.equal(created.name, "Revenue analysis");
  assert.deepEqual(created.blocks, []);
  assert.ok(created.id && created.createdAt && created.updatedAt);

  const fetched = await svc.get(WS, created.id);
  assert.ok(fetched);
  assert.equal(fetched?.name, "Revenue analysis");

  const list = await svc.list(WS);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
}

async function testDefaultNameAndUpdate() {
  const created = await svc.create(WS, {});
  assert.equal(created.name, "Untitled notebook");

  const updated = await svc.update(WS, created.id, {
    name: "Renamed",
    blocks: [{ id: "b1", type: "sql", source: "select 1" }],
  });
  assert.equal(updated?.name, "Renamed");
  assert.equal(updated?.blocks.length, 1);
  assert.equal(updated?.blocks[0].source, "select 1");
  assert.ok(
    (updated?.updatedAt ?? "") >= created.updatedAt,
    "updatedAt should advance",
  );
}

async function testWorkspaceIsolation() {
  const a = await svc.create(WS, { name: "A only" });
  // WS2 must not see WS's notebook.
  assert.equal(await svc.get(WS2, a.id), null);
  const otherList = await svc.list(WS2);
  assert.ok(!otherList.some(n => n.id === a.id));
}

async function testMissingAndBadIds() {
  assert.equal(await svc.get(WS, "does-not-exist"), null);
  assert.equal(await svc.update(WS, "does-not-exist", { name: "x" }), null);
  assert.equal(await svc.remove(WS, "does-not-exist"), false);
  // Path-traversal id is rejected as not-found, never touching the fs path.
  assert.equal(await svc.get(WS, "../../etc/passwd"), null);
  assert.equal(await svc.remove(WS, "../../etc/passwd"), false);
}

async function testRemove() {
  const created = await svc.create(WS, { name: "To delete" });
  assert.equal(await svc.remove(WS, created.id), true);
  assert.equal(await svc.get(WS, created.id), null);
}

async function main() {
  try {
    await testCreateGetListRoundTrip();
    await testDefaultNameAndUpdate();
    await testWorkspaceIsolation();
    await testMissingAndBadIds();
    await testRemove();
    console.log(
      "notebook-workingtree.service.test: OK — CRUD + isolation + guards",
    );
  } finally {
    await fs
      .rm(WORKDIR, { recursive: true, force: true })
      .catch(() => undefined);
  }
  process.exit(0);
}

void main();
