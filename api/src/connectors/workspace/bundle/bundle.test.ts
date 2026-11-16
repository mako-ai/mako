/**
 * Connector bundles, the pieces: the source hash, the guard, the dependency
 * plan, the build box's commands and the build-once pipeline.
 *
 * The sandbox provider and the artifact store are mocked. What is asserted is
 * what each piece promises: a hash that moves exactly when its inputs move, a
 * refusal that says how to fix it, a build that runs with no credential and
 * never reads unbounded output, and one build per hash.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  scratch: vi.fn(() => "/scratch"),
  destroySession: vi.fn(async (_key: string) => {}),
}));
vi.mock("../../../apps/sandbox/provider", () => ({
  getSandboxProvider: () => sandbox,
}));

const store = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  puts: [] as Array<{ key: string; contentType: string }>,
}));
vi.mock("../../../services/artifact-store.service", () => ({
  getArtifactPrefix: () => "dashboards",
  getArtifactStore: () => ({
    exists: async (key: string) => store.objects.has(key),
    openRead: async (key: string) => {
      const bytes = store.objects.get(key);
      if (!bytes) return null;
      const { Readable } = await import("node:stream");
      return {
        stream: Readable.from([Buffer.from(bytes)]),
        size: bytes.length,
      };
    },
    putBuffer: async (bytes: Uint8Array, key: string, contentType: string) => {
      store.objects.set(key, new Uint8Array(bytes));
      store.puts.push({ key, contentType });
    },
  }),
}));

vi.mock("../resolver", () => ({
  ensureConnectorRuntime: vi.fn(async () => "runtime"),
  connectorSdkVersion: vi.fn(async () => "0.1.0"),
}));
vi.mock("../../../database/workspace-schema", () => ({
  ConnectorDefinition: { updateOne: vi.fn() },
}));

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dependencyPlan,
  findNodeModules,
  lockfileProblem,
  nodeModulesRefusal,
} from "./manifest";
import { bundleSourceHash } from "./source-hash";
import { bundleKey, MAX_BUNDLE_BYTES } from "./store";
import { buildBundleInBox, esbuildEntryArg } from "./build-box";
import { BundleBuildError, ensureBundle, shouldBundle } from "./bundle.service";
import { CONNECTOR_BUNDLES_FLAG, connectorBundlesEnabled } from "./flag";

const enc = (text: string) => new TextEncoder().encode(text);
const WS = "0123456789abcdef01234567";

const LOCK = JSON.stringify({
  name: "acme",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { dependencies: { "date-fns": "4.1.0" } },
    "node_modules/date-fns": {
      version: "4.1.0",
      resolved: "https://registry.npmjs.org/date-fns/-/date-fns-4.1.0.tgz",
      integrity:
        "sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==",
    },
  },
});

const folder = (extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({
      "connector.yaml": "runtime: node\n",
      "connector.ts": "export default {};\n",
      "package.json": '{"dependencies":{"date-fns":"4.1.0"}}',
      "package-lock.json": LOCK,
      ...extra,
    }).map(([name, text]) => [name, enc(text)]),
  );

const ok = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  durationMs: 1,
  truncated: false,
});

describe("the source hash", () => {
  it("is stable for the same folder, whatever order its files arrive in", () => {
    const a = folder();
    const b = new Map([...folder()].reverse());
    expect(bundleSourceHash({ files: a, sdkVersion: "0.1.0" })).toBe(
      bundleSourceHash({ files: b, sdkVersion: "0.1.0" }),
    );
    expect(bundleSourceHash({ files: a, sdkVersion: "0.1.0" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("changes when a source file changes", () => {
    const base = bundleSourceHash({ files: folder(), sdkVersion: "0.1.0" });
    const edited = folder({ "connector.ts": "export default { v: 2 };\n" });
    expect(bundleSourceHash({ files: edited, sdkVersion: "0.1.0" })).not.toBe(
      base,
    );
    const added = folder({ "lib/util.ts": "export const x = 1;\n" });
    expect(bundleSourceHash({ files: added, sdkVersion: "0.1.0" })).not.toBe(
      base,
    );
  });

  it("changes when the lockfile changes", () => {
    const base = bundleSourceHash({ files: folder(), sdkVersion: "0.1.0" });
    const relocked = folder({
      "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
    });
    expect(bundleSourceHash({ files: relocked, sdkVersion: "0.1.0" })).not.toBe(
      base,
    );
  });

  it("changes when the SDK version changes", () => {
    expect(bundleSourceHash({ files: folder(), sdkVersion: "0.1.0" })).not.toBe(
      bundleSourceHash({ files: folder(), sdkVersion: "0.2.0" }),
    );
  });

  it("does not confuse a file's name with its contents", () => {
    const one = new Map([["a", enc("b")]]);
    const two = new Map([["ab", enc("")]]);
    expect(bundleSourceHash({ files: one, sdkVersion: "1" })).not.toBe(
      bundleSourceHash({ files: two, sdkVersion: "1" }),
    );
  });
});

describe("the node_modules guard", () => {
  it("finds a node_modules path at any depth", () => {
    expect(findNodeModules(["connector.ts", "package.json"])).toBeNull();
    expect(
      findNodeModules(["connector.ts", "node_modules/date-fns/index.js"]),
    ).toBe("node_modules/date-fns/index.js");
    expect(findNodeModules(["lib/node_modules/x.js"])).toBe(
      "lib/node_modules/x.js",
    );
    // A name that merely contains the word is not the directory.
    expect(findNodeModules(["my_node_modules.md"])).toBeNull();
  });

  it("says how to fix it", () => {
    const message = nodeModulesRefusal("acme");
    expect(message).toContain("connectors/acme/ contains node_modules/");
    expect(message).toContain(
      "git rm -r --cached connectors/acme/node_modules",
    );
    expect(message).toContain("package-lock.json");
  });
});

describe("the dependency plan", () => {
  it("leaves a folder without package.json alone", () => {
    const files = folder();
    files.delete("package.json");
    files.delete("package-lock.json");
    expect(dependencyPlan(files)).toEqual({ kind: "none" });
  });

  it("accepts package.json with package-lock.json", () => {
    expect(dependencyPlan(folder())).toEqual({ kind: "npm" });
  });

  it("refuses package.json without a lockfile, with the command to run", () => {
    const files = folder();
    files.delete("package-lock.json");
    const plan = dependencyPlan(files);
    expect(plan.kind).toBe("invalid");
    if (plan.kind === "invalid") expect(plan.reason).toContain("npm install");
  });

  it("refuses a pnpm lockfile and names the one it needs", () => {
    const files = folder({ "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    files.delete("package-lock.json");
    const plan = dependencyPlan(files);
    expect(plan.kind).toBe("invalid");
    if (plan.kind === "invalid") {
      expect(plan.reason).toContain("pnpm-lock.yaml");
      expect(plan.reason).toContain("package-lock.json");
    }
  });

  it("refuses a package.json that is not JSON", () => {
    const plan = dependencyPlan(folder({ "package.json": "{nope" }));
    expect(plan.kind).toBe("invalid");
  });

  it("refuses a .npmrc in the folder, which npm ci would read", () => {
    const plan = dependencyPlan(
      folder({ ".npmrc": "registry=https://evil.example/\n" }),
    );
    expect(plan.kind).toBe("invalid");
    if (plan.kind === "invalid") expect(plan.reason).toContain(".npmrc");
  });
});

describe("the lockfile check", () => {
  const lock = (packages: Record<string, unknown>, lockfileVersion = 3) => ({
    lockfileVersion,
    packages: { "": {}, ...packages },
  });
  const registry = (name: string) => ({
    version: "1.0.0",
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: "sha512-abc",
  });

  it("accepts packages from the npm registry, and packages bundled inside them", () => {
    expect(
      lockfileProblem(
        lock({
          "node_modules/a": registry("a"),
          "node_modules/a/node_modules/b": { version: "1.0.0", inBundle: true },
        }),
      ),
    ).toBeNull();
  });

  it("accepts the lockfile of the stripe connector in this repo", () => {
    const file = path.resolve(
      __dirname,
      "../../../../../connectors/stripe/package-lock.json",
    );
    expect(lockfileProblem(JSON.parse(readFileSync(file, "utf8")))).toBeNull();
  });

  it("refuses a git dependency", () => {
    expect(
      lockfileProblem(
        lock({
          "node_modules/evil": {
            version: "1.0.0",
            resolved: "git+ssh://git@github.com/evil/evil.git#0123456",
            integrity: "sha512-abc",
          },
        }),
      ),
    ).toContain("git+ssh://git@github.com/evil/evil.git");
  });

  it("refuses a tarball from another host", () => {
    expect(
      lockfileProblem(
        lock({
          "node_modules/evil": {
            ...registry("evil"),
            resolved: "https://registry.npmjs.org.evil.example/evil.tgz",
          },
        }),
      ),
    ).toContain("evil.example");
    expect(
      lockfileProblem(
        lock({
          "node_modules/evil": {
            ...registry("evil"),
            resolved: "http://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
          },
        }),
      ),
    ).not.toBeNull();
  });

  it("refuses file: and link: paths, inside the folder or out of it", () => {
    expect(
      lockfileProblem(
        lock({
          "node_modules/shared": { resolved: "../shared", link: true },
          "../shared": { version: "1.0.0" },
        }),
      ),
    ).toContain("local path");
    expect(
      lockfileProblem(lock({ "../../etc": { version: "1.0.0" } })),
    ).toContain("local path");
    expect(
      lockfileProblem(
        lock({
          "node_modules/x": {
            ...registry("x"),
            resolved: "file:../../x.tgz",
          },
        }),
      ),
    ).toContain("file:../../x.tgz");
  });

  it("refuses a package with no integrity hash", () => {
    expect(
      lockfileProblem(
        lock({ "node_modules/a": { ...registry("a"), integrity: undefined } }),
      ),
    ).toContain("integrity");
  });

  it("refuses a version 1 lockfile, which has no package list to check", () => {
    expect(lockfileProblem({ lockfileVersion: 1, dependencies: {} })).toContain(
      "lockfileVersion 2 or 3",
    );
  });

  it("is applied by the dependency plan", () => {
    const plan = dependencyPlan(
      folder({
        "package-lock.json": JSON.stringify(
          lock({
            "node_modules/evil": {
              resolved: "https://evil.example/evil.tgz",
              integrity: "sha512-abc",
            },
          }),
        ),
      }),
    );
    expect(plan.kind).toBe("invalid");
  });
});

describe("the flag", () => {
  it("is off unless set", () => {
    const before = process.env[CONNECTOR_BUNDLES_FLAG];
    try {
      delete process.env[CONNECTOR_BUNDLES_FLAG];
      expect(connectorBundlesEnabled()).toBe(false);
      expect(shouldBundle("node", folder())).toBe(false);
      process.env[CONNECTOR_BUNDLES_FLAG] = "true";
      expect(connectorBundlesEnabled()).toBe(true);
      expect(shouldBundle("node", folder())).toBe(true);
      const plain = folder();
      plain.delete("package.json");
      plain.delete("package-lock.json");
      // No package.json: the TypeScript entry runs as before, flag or not.
      expect(shouldBundle("node", plain)).toBe(false);
    } finally {
      if (before === undefined) delete process.env[CONNECTOR_BUNDLES_FLAG];
      else process.env[CONNECTOR_BUNDLES_FLAG] = before;
    }
  });
});

describe("the storage layout", () => {
  it("names a bundle by workspace and hash, and refuses anything else", () => {
    const hash = "a".repeat(64);
    expect(bundleKey(WS, hash)).toBe(
      `dashboards/connector-bundles/${WS}/${hash}.mjs`,
    );
    expect(() => bundleKey(WS, "../escape")).toThrow(/Invalid bundle hash/);
    expect(() => bundleKey("../x", hash)).toThrow(/Invalid workspace id/);
  });
});

describe("the build box", () => {
  beforeEach(() => {
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.destroySession.mockClear();
  });

  it("copies the folder in, installs from the lockfile and bundles the entry", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("--bundle") ? ok("42\n") : ok(),
    );
    sandbox.readFile.mockResolvedValue(enc("export default 1;\n"));

    const result = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme",
      hash: "b".repeat(64),
      entry: "connector.ts",
      files: folder(),
    });
    expect(result.ok).toBe(true);

    // A box of its own: never the sync box, never a session box, and
    // destroyed once the build is over.
    const keys = new Set(
      sandbox.exec.mock.calls.map(([ctx]) => ctx.sessionKey as string),
    );
    expect(keys.size).toBe(1);
    const [key] = [...keys];
    expect(key).toMatch(new RegExp(`^connector-build:${WS}:bbbbbbbbbbbbbbbb-`));
    expect(sandbox.destroySession.mock.calls).toEqual([[key]]);

    // Every file of the folder, copied in; no clone, no token.
    const written = sandbox.writeFile.mock.calls.map(([, file]) =>
      String(file),
    );
    expect(written.some(file => file.endsWith("/src/connector.ts"))).toBe(true);
    expect(written.some(file => file.endsWith("/src/package-lock.json"))).toBe(
      true,
    );
    const commands = sandbox.exec.mock.calls.map(([, command]) =>
      String(command),
    );
    expect(commands.some(command => /git (clone|remote)/.test(command))).toBe(
      false,
    );
    // No extra environment beyond the provider's allowlist.
    for (const [, , options] of sandbox.exec.mock.calls) {
      expect(options?.env).toBeUndefined();
    }

    const install = commands.find(command => command.includes("npm ci"));
    expect(install).toContain("--ignore-scripts");
    expect(install).toContain("--registry='https://registry.npmjs.org/'");
    expect(install).toContain("npm_config_userconfig=/dev/null");
    // The bundler is installed without running its scripts too.
    const tools = commands.find(command => command.includes("esbuild@"));
    expect(tools).toContain("--ignore-scripts");
    expect(tools).toContain("--registry='https://registry.npmjs.org/'");
    const bundle = commands.find(command => command.includes("--bundle"));
    expect(bundle).toContain("--external:@makoai/connector-sdk");
    expect(bundle).toContain("--format=esm");
    expect(bundle).toContain("'./connector.ts'");
  });

  it("gives every build its own box, even two builds of one workspace", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("--bundle") ? ok("42\n") : ok(),
    );
    sandbox.readFile.mockResolvedValue(enc("export default 1;\n"));
    await Promise.all(
      ["1", "2"].map(n =>
        buildBundleInBox({
          workspaceId: WS,
          slug: "acme",
          hash: n.repeat(64),
          entry: "connector.ts",
          files: folder(),
        }),
      ),
    );
    const keys = new Set(
      sandbox.exec.mock.calls.map(([ctx]) => ctx.sessionKey as string),
    );
    expect(keys.size).toBe(2);
    expect(new Set(sandbox.destroySession.mock.calls.map(([k]) => k))).toEqual(
      keys,
    );
  });

  it("destroys the box when the build fails or throws", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) => {
      if (command.includes("npm ci")) throw new Error("box went away");
      return ok();
    });
    await expect(
      buildBundleInBox({
        workspaceId: WS,
        slug: "acme",
        hash: "f".repeat(64),
        entry: "connector.ts",
        files: folder(),
      }),
    ).rejects.toThrow("box went away");
    expect(sandbox.destroySession).toHaveBeenCalledTimes(1);
  });

  it("refuses a .npmrc before it reaches a box", async () => {
    const result = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme",
      hash: "a".repeat(64),
      entry: "connector.ts",
      files: folder({ ".npmrc": "registry=https://evil.example/\n" }),
    });
    expect(result.ok).toBe(false);
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("passes the entry to esbuild as a path, never as a flag", () => {
    expect(esbuildEntryArg("connector.ts")).toBe("./connector.ts");
    expect(esbuildEntryArg("--watch")).toBe("./--watch");
    expect(esbuildEntryArg("src/main.ts")).toBe("./src/main.ts");
    expect(esbuildEntryArg("./main.ts")).toBe("./main.ts");
  });

  it("reports npm's own words when the install fails, and stops there", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("npm ci")
        ? {
            ...ok(),
            exitCode: 1,
            stderr:
              "npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope",
          }
        : ok(),
    );
    const result = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme",
      hash: "c".repeat(64),
      entry: "connector.ts",
      files: folder(),
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("npm ci failed: npm ERR! 404"),
    });
    expect(
      sandbox.exec.mock.calls.some(([, command]) =>
        String(command).includes("--bundle"),
      ),
    ).toBe(false);
  });

  it("refuses an oversized bundle before reading it into the API", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("--bundle") ? ok(`${MAX_BUNDLE_BYTES + 1}\n`) : ok(),
    );
    const result = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme",
      hash: "d".repeat(64),
      entry: "connector.ts",
      files: folder(),
    });
    expect(result.ok).toBe(false);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("refuses a path that escapes the build directory", async () => {
    sandbox.exec.mockResolvedValue(ok());
    const result = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme",
      hash: "e".repeat(64),
      entry: "connector.ts",
      files: new Map([["../../evil.sh", enc("x")]]),
    });
    expect(result.ok).toBe(false);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });
});

describe("one build per hash", () => {
  beforeEach(() => {
    store.objects.clear();
    store.puts.length = 0;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("--bundle") ? ok("18\n") : ok(),
    );
    sandbox.readFile.mockResolvedValue(enc("export default 1;\n"));
  });

  const builds = () =>
    sandbox.exec.mock.calls.filter(([, command]) =>
      String(command).includes("--bundle"),
    ).length;

  it("builds once, stores the bundle, then serves it from storage", async () => {
    const first = await ensureBundle({
      workspaceId: WS,
      slug: "acme",
      entry: "connector.ts",
      files: folder(),
    });
    expect(first.built).toBe(true);
    expect(store.puts).toEqual([
      {
        key: `dashboards/connector-bundles/${WS}/${first.hash}.mjs`,
        contentType: "text/javascript",
      },
    ]);

    const second = await ensureBundle({
      workspaceId: WS,
      slug: "acme",
      entry: "connector.ts",
      files: folder(),
    });
    expect(second.built).toBe(false);
    expect(second.hash).toBe(first.hash);
    expect(new TextDecoder().decode(second.bytes)).toBe("export default 1;\n");
    expect(builds()).toBe(1);
  });

  it("shares one build between concurrent callers", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        ensureBundle({
          workspaceId: WS,
          slug: "acme",
          entry: "connector.ts",
          files: folder(),
        }),
      ),
    );
    expect(new Set(results.map(result => result.hash)).size).toBe(1);
    expect(builds()).toBe(1);
  });

  it("throws a build error that carries the hash and the reason, and caches nothing", async () => {
    sandbox.exec.mockImplementation(async (_ctx, command: string) =>
      command.includes("--bundle")
        ? { ...ok(), exitCode: 1, stderr: 'Could not resolve "date-fns"' }
        : ok(),
    );
    const error = await ensureBundle({
      workspaceId: WS,
      slug: "acme",
      entry: "connector.ts",
      files: folder(),
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(BundleBuildError);
    expect((error as BundleBuildError).hash).toMatch(/^[0-9a-f]{64}$/);
    expect((error as BundleBuildError).message).toContain(
      'Build failed: esbuild failed: Could not resolve "date-fns"',
    );
    expect(store.puts).toHaveLength(0);
  });
});
