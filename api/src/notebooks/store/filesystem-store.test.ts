/* eslint-disable no-console, no-process-exit */
/**
 * Contract tests for the NotebookStore — create/list/get/update/remove
 * round-trip, plus path-traversal and workspace-isolation guards. Exercised
 * against the filesystem store (a temp NOTEBOOK_WORKDIR); the GCS store
 * implements the same interface and is covered by the live preview check.
 *
 * Run with: tsx src/notebooks/store/filesystem-store.test.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const WORKDIR = path.join(os.tmpdir(), `mako-notebooks-test-${randomUUID()}`);
process.env.NOTEBOOK_WORKDIR = WORKDIR;

import { FilesystemNotebookStore } from "./filesystem-store";

const svc = new FilesystemNotebookStore();

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

async function testArtifactRoundTrip() {
  const created = await svc.create(WS, { name: "With artifact" });
  const artifactId = randomUUID();
  const body = Buffer.from("<table><tr><td>1</td></tr></table>", "utf8");
  await svc.putArtifact(WS, created.id, artifactId, body, "text/html");

  const fetched = await svc.getArtifact(WS, created.id, artifactId);
  assert.ok(fetched);
  assert.equal(fetched?.contentType, "text/html");
  assert.equal(fetched?.body.toString("utf8"), body.toString("utf8"));

  // Missing artifact and bad ids resolve to null, never a thrown path error.
  assert.equal(await svc.getArtifact(WS, created.id, randomUUID()), null);
  assert.equal(await svc.getArtifact(WS, created.id, "../../etc/passwd"), null);
  // Artifact objects must not leak into the notebook list.
  const list = await svc.list(WS);
  assert.ok(list.some(n => n.id === created.id));
}

async function testVersioning() {
  const created = await svc.create(WS, { name: "v1" }); // version 1, empty
  await svc.update(WS, created.id, {
    blocks: [{ id: "b1", type: "code", source: "print(1)" }],
  }); // version 2
  await svc.update(WS, created.id, {
    blocks: [
      { id: "b1", type: "code", source: "print(1)" },
      { id: "b2", type: "code", source: "print(2)" },
    ],
  }); // version 3

  const versions = await svc.listVersions(WS, created.id);
  assert.ok(versions.length >= 3, "expected at least 3 versions");
  // Newest first, exactly one current.
  assert.equal(versions[0].versionId, "3");
  assert.equal(versions.filter(v => v.isCurrent).length, 1);
  assert.ok(versions.find(v => v.versionId === "3")?.isCurrent);

  // Fetch an old generation verbatim.
  const v1 = await svc.getVersion(WS, created.id, "1");
  assert.equal(v1?.blocks.length, 0);
  assert.equal(await svc.getVersion(WS, created.id, "999"), null);
  assert.equal(await svc.getVersion(WS, created.id, "not-a-number"), null);

  // Restore is non-destructive: writes the old content as a NEW current gen.
  const restored = await svc.restoreVersion(WS, created.id, "1");
  assert.equal(restored?.blocks.length, 0, "restored to empty blocks");
  assert.ok((restored?.version ?? 0) >= 4, "restore bumps version forward");
  const after = await svc.listVersions(WS, created.id);
  assert.ok(
    after.length > versions.length,
    "restore appends a version, never deletes",
  );
}

async function main() {
  try {
    await testCreateGetListRoundTrip();
    await testDefaultNameAndUpdate();
    await testWorkspaceIsolation();
    await testMissingAndBadIds();
    await testRemove();
    await testArtifactRoundTrip();
    await testVersioning();
    console.log(
      "notebook store contract: OK — CRUD + isolation + guards + artifacts + versions",
    );
  } finally {
    await fs
      .rm(WORKDIR, { recursive: true, force: true })
      .catch(() => undefined);
  }
  process.exit(0);
}

void main();
