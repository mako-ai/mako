import { afterEach, expect, it, vi } from "vitest";
import { resetPgTestDb } from "../database/pg/client";
import {
  ensureTestDatabaseConnection,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../test-support/pg-test";
import {
  PgAuthRepository,
  authRepo,
  resetAuthRepoForTests,
  setAuthRepoForTests,
} from "./auth";
import { connectionsRepo } from "./connections";

afterEach(() => {
  resetAuthRepoForTests();
  resetPgTestDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("requires runtime Postgres configuration for core repository reads", async () => {
  vi.stubEnv("POSTGRES_URL", "");
  vi.stubEnv("POSTGRES_DIRECT_URL", "postgres://localhost/direct-only");
  await expect(authRepo.findUserByEmail("user@example.test")).rejects.toThrow(
    /POSTGRES_URL/,
  );
});

it("restores default reads after repository overrides and singleton spies", async () => {
  const h = await setupPgTestDb();
  try {
    const user = await ensureTestUser(h.db);
    const workspace = await ensureTestWorkspace(h.db);
    const connection = await ensureTestDatabaseConnection(h.db, {
      workspaceId: workspace.id,
    });

    const override = new PgAuthRepository();
    const findUserByEmail = vi
      .spyOn(override, "findUserByEmail")
      .mockResolvedValue(null);
    setAuthRepoForTests(override);
    expect(await authRepo.findUserByEmail(user.email)).toBeNull();
    expect(findUserByEmail).toHaveBeenCalledWith(user.email);
    resetAuthRepoForTests();
    expect(await authRepo.findUserByEmail(user.email)).toMatchObject({
      email: user.email,
    });

    const spy = vi
      .spyOn(connectionsRepo, "listDatabaseConnections")
      .mockResolvedValue([]);
    expect(await connectionsRepo.listDatabaseConnections(workspace.id)).toEqual(
      [],
    );
    expect(spy).toHaveBeenCalledWith(workspace.id);
    spy.mockRestore();
    expect(
      await connectionsRepo.listDatabaseConnections(workspace.id),
    ).toMatchObject([{ id: connection.id }]);
  } finally {
    await h.close();
  }
});
