/**
 * Apps env vault — the properties that make it safe to exist.
 *
 * The vault holds tenant credentials, so the specs pin the security posture
 * rather than CRUD mechanics: values are encrypted at rest, secrets never
 * echo back through the list, the build target can never see a secret, and
 * the VITE_/secret contradiction is refused at the door. Real mongoose against
 * mongodb-memory-server — encryption and persistence are the subject here,
 * not something to mock away.
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppEnvValidationError,
  deleteAppEnvVar,
  listAppEnvVars,
  resolveAppEnv,
  setAppEnvVar,
  validateAppEnvInput,
} from "./env.service";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { isEncryptedValue } from "../services/crypto.service";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function makeProject(): Promise<IAppProject> {
  return AppProject.create({
    workspaceId: new Types.ObjectId(),
    title: "Env test app",
    slug: `env-test-${new Types.ObjectId().toString().slice(-8)}`,
    access: "workspace",
    createdBy: "tester",
  });
}

describe("validateAppEnvInput", () => {
  it("accepts ordinary env-shaped keys, secret or not", () => {
    validateAppEnvInput({ key: "API_BASE_URL", value: "x", secret: false });
    validateAppEnvInput({ key: "_private", value: "x", secret: true });
    validateAppEnvInput({
      key: "VITE_GOOGLE_MAPS_API_KEY",
      value: "AIza...",
      secret: false,
    });
  });

  it("rejects names that are not env-var-shaped", () => {
    for (const key of ["1BAD", "has space", "has-dash", "", "a.b"]) {
      expect(() =>
        validateAppEnvInput({ key, value: "x", secret: false }),
      ).toThrow(AppEnvValidationError);
    }
  });

  it("rejects the sandbox's reserved names and the MAKO_ prefix", () => {
    for (const key of ["PATH", "HOME", "GIT_TERMINAL_PROMPT", "MAKO_API"]) {
      expect(() =>
        validateAppEnvInput({ key, value: "x", secret: false }),
      ).toThrow(/reserved/);
    }
  });

  it("refuses a secret with the VITE_ prefix — Vite would publish it", () => {
    expect(() =>
      validateAppEnvInput({
        key: "VITE_STRIPE_SECRET",
        value: "x",
        secret: true,
      }),
    ).toThrow(/public client bundle/);
    // Case games do not smuggle it through.
    expect(() =>
      validateAppEnvInput({ key: "vite_secretish", value: "x", secret: true }),
    ).toThrow(AppEnvValidationError);
  });

  it("caps value size", () => {
    expect(() =>
      validateAppEnvInput({
        key: "BIG",
        value: "x".repeat(8193),
        secret: false,
      }),
    ).toThrow(/limited/);
  });
});

describe("set / list / delete", () => {
  it("stores values encrypted at rest and lists non-secret values back", async () => {
    const project = await makeProject();
    await setAppEnvVar(project, {
      key: "VITE_MAPS_KEY",
      value: "AIzaPlainlyVisible",
      secret: false,
    });

    const row = await AppProject.findById(project._id);
    expect(row?.env).toHaveLength(1);
    expect(row?.env?.[0].valueEncrypted).not.toContain("AIzaPlainlyVisible");
    expect(isEncryptedValue(row?.env?.[0].valueEncrypted ?? "")).toBe(true);

    const listed = await listAppEnvVars(project);
    expect(listed).toEqual([
      { key: "VITE_MAPS_KEY", secret: false, value: "AIzaPlainlyVisible" },
    ]);
  });

  it("never echoes a secret's value back through the list", async () => {
    const project = await makeProject();
    await setAppEnvVar(project, {
      key: "GEOCODING_SERVER_KEY",
      value: "hunter2",
      secret: true,
    });
    const listed = await listAppEnvVars(project);
    expect(listed).toEqual([{ key: "GEOCODING_SERVER_KEY", secret: true }]);
    expect(JSON.stringify(listed)).not.toContain("hunter2");
  });

  it("upserts by key, including flipping the secret flag", async () => {
    const project = await makeProject();
    await setAppEnvVar(project, { key: "K", value: "v1", secret: false });
    await setAppEnvVar(project, { key: "K", value: "v2", secret: true });
    const listed = await listAppEnvVars(project);
    expect(listed).toEqual([{ key: "K", secret: true }]);
    const dev = await resolveAppEnv(project, "dev");
    expect(dev).toEqual({ K: "v2" });
  });

  it("deletes idempotently", async () => {
    const project = await makeProject();
    await setAppEnvVar(project, { key: "GONE", value: "x", secret: false });
    expect(await deleteAppEnvVar(project, "GONE")).toBe(true);
    expect(await deleteAppEnvVar(project, "GONE")).toBe(false);
    expect(await listAppEnvVars(project)).toEqual([]);
  });

  it("rejects invalid input at the service door too", async () => {
    const project = await makeProject();
    await expect(
      setAppEnvVar(project, { key: "PATH", value: "x", secret: false }),
    ).rejects.toThrow(AppEnvValidationError);
  });
});

describe("resolveAppEnv", () => {
  it("dev gets everything; build can never see a secret", async () => {
    const project = await makeProject();
    await setAppEnvVar(project, {
      key: "VITE_PUBLIC",
      value: "pub",
      secret: false,
    });
    await setAppEnvVar(project, { key: "SECRET", value: "shh", secret: true });

    expect(await resolveAppEnv(project, "dev")).toEqual({
      VITE_PUBLIC: "pub",
      SECRET: "shh",
    });
    expect(await resolveAppEnv(project, "build")).toEqual({
      VITE_PUBLIC: "pub",
    });
  });

  it("reads the vault, not the caller's stale copy of the project", async () => {
    const project = await makeProject();
    // A handle can hold a project loaded long before an env edit — resolving
    // through that stale doc must still see the current vault.
    const stale = await AppProject.findById(project._id);
    await setAppEnvVar(project, {
      key: "ADDED_LATER",
      value: "v",
      secret: false,
    });
    expect(await resolveAppEnv(stale as IAppProject, "dev")).toEqual({
      ADDED_LATER: "v",
    });
  });
});
