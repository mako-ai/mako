import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../database/pg/client";
import { createPgFirstRepoProxy } from "./resolve-repo";

interface DemoRepo {
  tag(): string;
}

describe("createPgFirstRepoProxy", () => {
  const savedPgUrl = process.env.POSTGRES_URL;
  const savedVitest = process.env.VITEST;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedFallback = process.env.MAKO_TEST_MONGO_FALLBACK;

  afterEach(() => {
    resetPgTestDb();
    if (savedPgUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = savedPgUrl;
    }
    if (savedVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = savedVitest;
    }
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    if (savedFallback === undefined) {
      delete process.env.MAKO_TEST_MONGO_FALLBACK;
    } else {
      process.env.MAKO_TEST_MONGO_FALLBACK = savedFallback;
    }
  });

  it("dispatches directly to pgRepo whenever Postgres is configured", () => {
    const pgTag = vi.fn(() => "pg");
    const mongoTag = vi.fn(() => "mongo");
    const proxy = createPgFirstRepoProxy<DemoRepo>(
      "demo",
      { tag: pgTag },
      { tag: mongoTag },
    );

    setPgTestDb({} as MakoPgDb);
    expect(proxy.tag()).toBe("pg");
    expect(pgTag).toHaveBeenCalledTimes(1);
    expect(mongoTag).not.toHaveBeenCalled();
  });

  it("uses Mongo test fallback only in test env when Postgres is unset", () => {
    delete process.env.POSTGRES_URL;
    resetPgTestDb();
    const proxy = createPgFirstRepoProxy<DemoRepo>(
      "demo",
      { tag: () => "pg" },
      { tag: () => "mongo" },
    );
    expect(proxy.tag()).toBe("mongo");
  });

  it("supports vi.spyOn and mockRestore in both PG and Mongo fallback modes", () => {
    class PgDemo implements DemoRepo {
      tag() {
        return "pg";
      }
    }
    class MongoDemo implements DemoRepo {
      tag() {
        return "mongo";
      }
    }
    const proxy = createPgFirstRepoProxy<DemoRepo>(
      "demo",
      new PgDemo(),
      new MongoDemo(),
    );

    // Mongo fallback mode (no POSTGRES_URL)
    delete process.env.POSTGRES_URL;
    resetPgTestDb();
    const mongoSpy = vi.spyOn(proxy, "tag").mockReturnValue("spied-mongo");
    expect(proxy.tag()).toBe("spied-mongo");
    expect(mongoSpy).toHaveBeenCalledTimes(1);
    mongoSpy.mockRestore();
    expect(proxy.tag()).toBe("mongo");

    // PG mode (PGlite / POSTGRES_URL set)
    setPgTestDb({} as MakoPgDb);
    expect(proxy.tag()).toBe("pg");
    const pgSpy = vi.spyOn(proxy, "tag").mockReturnValue("spied-pg");
    expect(proxy.tag()).toBe("spied-pg");
    expect(pgSpy).toHaveBeenCalledTimes(1);
    pgSpy.mockRestore();
    expect(proxy.tag()).toBe("pg");
  });

  it("fails fast in non-test environments when POSTGRES_URL is unset", () => {
    delete process.env.POSTGRES_URL;
    delete process.env.VITEST;
    delete process.env.MAKO_TEST_MONGO_FALLBACK;
    process.env.NODE_ENV = "production";
    resetPgTestDb();

    const proxy = createPgFirstRepoProxy<DemoRepo>(
      "demo",
      { tag: () => "pg" },
      { tag: () => "mongo" },
    );
    expect(() => proxy.tag()).toThrow(/\[demo\] POSTGRES_URL is required/);
  });
});
