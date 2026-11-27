/** Second review of PR #1190: the conditional repoint on PGlite. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { eq } from "drizzle-orm";
import { objectIdToUuid } from "../database/pg/id-codec";
import { appProjects } from "../database/pg/schema";
import {
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../repositories/apps-metadata";
import { setPublishedSha } from "./deployment.service";

let pgh: PgTestDb;
const [A, B, C] = ["a", "b", "c"].map(c => c.repeat(40));
const WS = new Types.ObjectId().toString();
let id: string;
let project: ReturnType<typeof toAppProjectCompat>;
const row = async () => {
  const record = await appsMetadataRepo.findProjectById(id, WS);
  if (!record) throw new Error("Missing app fixture");
  return record;
};

beforeAll(async () => {
  pgh = await setupPgTestDb();
}, 120_000);
afterAll(async () => {
  await pgh?.close();
});
beforeEach(async () => {
  await pgh.reset();
  await ensureTestWorkspace(pgh.db, { id: WS });
  id = new Types.ObjectId().toString();
  project = toAppProjectCompat(
    await appsMetadataRepo.createProject({
      id,
      workspaceId: WS,
      title: "Review app",
      slug: `s${id}`,
      publishedSha: A,
    }),
  );
});

describe("conditional repoint", () => {
  it("HELD: of two racing deploys from one pointer, exactly one wins", async () => {
    const [x, y] = await Promise.all([
      setPublishedSha(project, B, { expected: A }),
      setPublishedSha(project, C, { expected: A }),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect((await row()).publishedSha).toBe(x ? B : C);
  });
  it("HELD: a first publish (expected null) matches a row with no pointer", async () => {
    await pgh.db
      .update(appProjects)
      .set({ publishedSha: null })
      .where(eq(appProjects.id, objectIdToUuid(id)));
    await expect(setPublishedSha(project, B, { expected: null })).resolves.toBe(
      true,
    );
    expect((await row()).publishedSha).toBe(B);
  });
  it("HELD: same-commit landing twice both succeed (a retry is not a lost publish)", async () => {
    await expect(setPublishedSha(project, B, { expected: A })).resolves.toBe(
      true,
    );
    await expect(setPublishedSha(project, B, { expected: B })).resolves.toBe(
      true,
    );
  });
  it("HELD: Publish and rollback are unconditional, so they are the way out", async () => {
    await expect(setPublishedSha(project, C)).resolves.toBe(true);
    expect((await row()).publishedSha).toBe(C);
  });
  // Listed in the PR body. It contradicts review1190-status "a zombie of an older
  // commit must not erase the newer commit's failure": without a repo, both are
  // an unplaceable failed sha.
  it.fails(
    "OPEN: a good publish clears a failure of a commit force-pushed off main",
    async () => {
      await pgh.db
        .update(appProjects)
        .set({
          lastDeployError: {
            sha: "d".repeat(40),
            stage: "build",
            message: "x",
            at: new Date().toISOString(),
          },
        })
        .where(eq(appProjects.id, objectIdToUuid(id)));
      await setPublishedSha(project, B);
      expect((await row()).lastDeployError ?? null).toBeNull();
    },
  );
});
