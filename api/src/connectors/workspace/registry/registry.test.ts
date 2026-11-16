/**
 * The registry's pure parts and its storage: version ranges, the `source:`
 * reference, connector.yaml with and without the flag, resolution and
 * upgrades, the catalog merge, and the bundle store on the filesystem
 * artifact store.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConnectorFile } from "../connector-file";
import { maxSatisfying, parseRange, parseRegistryReference } from "./semver";
import { resolveReference } from "./registry.service";
import { authTypeOf, changelogFor, withVersion } from "./publish";
import {
  CatalogConflictError,
  catalogGeneration,
  emptyCatalog,
  readCatalog,
  readRegistryBundle,
  readRegistrySource,
  registryBundleKey,
  sha256Hex,
  writeCatalog,
  writeCatalogIfUnchanged,
  writeRegistryArtifacts,
  type RegistryCatalog,
  type RegistryVersion,
} from "./store";

const PUBLISHED = ["0.9.0", "1.0.0", "1.1.0", "1.1.3", "1.4.0", "2.0.0"];

const range = (text: string) => {
  const parsed = parseRange(text);
  if (!parsed) throw new Error(`unparsed ${text}`);
  return parsed;
};

describe("version ranges", () => {
  it.each([
    ["1", "1.4.0"],
    ["1.x", "1.4.0"],
    ["1.1", "1.1.3"],
    ["1.1.x", "1.1.3"],
    ["^1.1.0", "1.4.0"],
    ["~1.1.0", "1.1.3"],
    ["1.1.0", "1.1.0"],
    ["^0.9.0", "0.9.0"],
    ["2", "2.0.0"],
    ["3", null],
  ])("%s resolves to %s", (text, expected) => {
    expect(maxSatisfying(PUBLISHED, range(text))).toBe(expected);
  });

  it.each([">=1", "latest", "1.2.3-beta.1", "01", "*", ""])(
    "refuses %s",
    text => {
      expect(parseRange(text)).toBeNull();
    },
  );
});

describe("the source reference", () => {
  it("parses mako/<slug>@<range>", () => {
    const parsed = parseRegistryReference("mako/stripe@1");
    expect(parsed.ok && parsed.value.slug).toBe("stripe");
    expect(parsed.ok && parsed.value.range.text).toBe("1");
  });

  it.each([
    ["stripe@1", "mako/<slug>"],
    ["acme/stripe@1", "Only the mako publisher"],
    ["mako/stripe", "<publisher>/<slug>@<version range>"],
    ["mako/Stripe@1", "not a connector slug"],
    ["mako/stripe@latest", "not a version range"],
  ])("refuses %s with the fix", (text, reason) => {
    const parsed = parseRegistryReference(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(reason);
  });
});

describe("connector.yaml with source:", () => {
  it("reads source only with the registry on, and needs no runtime line", () => {
    const on = parseConnectorFile("source: mako/stripe@1\n", {
      registry: true,
    });
    expect(on.ok).toBe(true);
    expect(on.ok && on.value.source?.slug).toBe("stripe");
    expect(on.ok && on.value.runtime).toBe("node");

    // Off: exactly as before, where `source` was an unknown key and a
    // missing runtime a refusal.
    const off = parseConnectorFile("source: mako/stripe@1\n");
    expect(off.ok).toBe(false);
    expect(!off.ok && off.reason).toContain("needs a `runtime`");
    const offWithRuntime = parseConnectorFile(
      "runtime: node\nsource: mako/stripe@1\nentry: main.ts\n",
    );
    expect(offWithRuntime.ok && offWithRuntime.value.source).toBeUndefined();
    expect(offWithRuntime.ok && offWithRuntime.value.entry).toBe("main.ts");
  });

  it("refuses source together with entry", () => {
    const parsed = parseConnectorFile(
      "runtime: node\nsource: mako/stripe@1\nentry: connector.ts\n",
      { registry: true },
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain("both `source` and `entry`");
  });

  it("refuses a malformed reference with the form that works", () => {
    const parsed = parseConnectorFile("source: stripe\n", { registry: true });
    expect(!parsed.ok && parsed.reason).toContain("mako/stripe@1");
    const notString = parseConnectorFile("source: 1\n", { registry: true });
    expect(!notString.ok && notString.reason).toContain("must be a string");
  });
});

const version = (v: string, hash = v.replace(/\./g, "").padEnd(64, "a")) =>
  ({
    version: v,
    hash,
    sha256: "f".repeat(64),
    bytes: 10,
    sdkVersion: "0.1.0",
    entry: "connector.ts",
    entities: ["customers"],
    authType: "api_key",
    publishedAt: "2026-11-16T00:00:00.000Z",
  }) satisfies RegistryVersion;

function catalogWith(...versions: string[]): RegistryCatalog {
  return withVersion(emptyCatalog(), {
    slug: "stripe",
    name: "stripe",
    versions: versions.map(v => version(v)),
  });
}

describe("resolution", () => {
  const reference = (text: string) => {
    const parsed = parseRegistryReference(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.value;
  };

  it("takes the newest version in range and records a newer major", () => {
    const resolved = resolveReference(
      reference("mako/stripe@1"),
      catalogWith("1.0.0", "1.2.0", "2.0.0"),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolution).toMatchObject({
      ref: "mako/stripe@1",
      slug: "stripe",
      range: "1",
      version: "1.2.0",
      latest: "2.0.0",
      upgradeAvailable: "2.0.0",
    });
  });

  it("has no upgradeAvailable when the newest is in range", () => {
    const resolved = resolveReference(
      reference("mako/stripe@1"),
      catalogWith("1.0.0", "1.2.0"),
    );
    expect(resolved.ok && resolved.resolution.upgradeAvailable).toBe(undefined);
  });

  it("refuses an unknown connector and an empty range, naming what exists", () => {
    const unknown = resolveReference(
      reference("mako/close@1"),
      catalogWith("1.0.0"),
    );
    expect(!unknown.ok && unknown.reason).toContain("Published: mako/stripe");
    const none = resolveReference(
      reference("mako/stripe@3"),
      catalogWith("1.0.0", "2.0.0"),
    );
    expect(!none.ok && none.reason).toBe(
      "No version of mako/stripe matches @3. Published: 2.0.0, 1.0.0.",
    );
  });
});

describe("publishing helpers", () => {
  it("merges a version into the catalog, newest first, replacing its own", () => {
    let catalog = catalogWith("1.0.0");
    catalog = withVersion(catalog, {
      slug: "stripe",
      name: "Stripe 2",
      versions: [version("2.0.0")],
    });
    catalog = withVersion(catalog, {
      slug: "stripe",
      name: "Stripe 1.5",
      versions: [version("1.5.0")],
    });
    const entry = catalog.connectors.stripe;
    expect(entry.versions.map(v => v.version)).toEqual([
      "2.0.0",
      "1.5.0",
      "1.0.0",
    ]);
    // A backport does not rename the connector.
    expect(entry.name).toBe("Stripe 2");
  });

  it("reads a version's changelog section", () => {
    const markdown =
      "# Changelog\n\n## 1.1.0\n\n- Adds refunds.\n\n### Notes\n\nkept\n\n## [1.0.0] - 2026-11-01\n\n- First.\n";
    expect(changelogFor(markdown, "1.1.0")).toBe(
      "- Adds refunds.\n\n### Notes\n\nkept",
    );
    expect(changelogFor(markdown, "1.0.0")).toBe("- First.");
    expect(changelogFor(markdown, "1.0")).toBeUndefined();
    expect(changelogFor(undefined, "1.0.0")).toBeUndefined();
  });

  it("names the auth type from the spec", () => {
    expect(
      authTypeOf({
        connectionSpecification: {
          properties: { api_key: { airbyte_secret: true } },
        },
      }),
    ).toBe("api_key");
    expect(authTypeOf({ connectionSpecification: { properties: {} } })).toBe(
      "none",
    );
    expect(authTypeOf({ advanced_auth: {} })).toBe("oauth2");
  });
});

describe("the store", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "connector-registry-"));
    process.env.DASHBOARD_ARTIFACT_DIR = dir;
  });
  afterAll(async () => {
    delete process.env.DASHBOARD_ARTIFACT_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips the catalog, a bundle and its source under the registry prefix", async () => {
    expect(await readCatalog()).toEqual(emptyCatalog());

    const bytes = new TextEncoder().encode("export default 1;\n");
    const hash = "a".repeat(64);
    const record = { ...version("1.0.0", hash), sha256: sha256Hex(bytes) };
    await writeRegistryArtifacts({
      slug: "stripe",
      hash,
      bundle: bytes,
      source: {
        slug: "stripe",
        version: "1.0.0",
        hash,
        entry: "connector.ts",
        files: { "connector.ts": Buffer.from("x").toString("base64") },
      },
    });
    await writeCatalog(
      withVersion(emptyCatalog(), {
        slug: "stripe",
        name: "stripe",
        versions: [record],
      }),
    );

    expect(registryBundleKey("stripe", hash)).toBe(
      `connector-registry/stripe/bundles/${hash}.mjs`,
    );
    expect((await readCatalog()).connectors.stripe.versions[0].version).toBe(
      "1.0.0",
    );
    expect(await readRegistryBundle("stripe", record)).toEqual(bytes);
    expect((await readRegistrySource("stripe", hash))?.entry).toBe(
      "connector.ts",
    );
  });

  it("refuses a bundle whose bytes do not match the recorded sha256", async () => {
    const hash = "b".repeat(64);
    await writeRegistryArtifacts({
      slug: "stripe",
      hash,
      bundle: new TextEncoder().encode("tampered"),
      source: {
        slug: "stripe",
        version: "1.0.1",
        hash,
        entry: "connector.ts",
        files: {},
      },
    });
    await expect(
      readRegistryBundle("stripe", {
        version: "1.0.1",
        hash,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("does not match its recorded sha256");
  });

  it("refuses a slug or a hash that could escape the prefix", () => {
    expect(() => registryBundleKey("../x", "a".repeat(64))).toThrow();
    expect(() => registryBundleKey("stripe", "../../x")).toThrow();
  });
});

const gcs = vi.hoisted(() => ({
  saves: [] as Array<{ ifGenerationMatch?: number }>,
  conflict: false,
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({
          exists: async () => [true],
          getMetadata: async () => [{ generation: "17" }],
          save: async (
            _bytes: Buffer,
            options: { preconditionOpts?: { ifGenerationMatch?: number } },
          ) => {
            gcs.saves.push({
              ifGenerationMatch: options.preconditionOpts?.ifGenerationMatch,
            });
            if (gcs.conflict) {
              throw Object.assign(new Error("precondition"), { code: 412 });
            }
          },
        }),
      };
    }
  },
}));

describe("the catalog write on GCS", () => {
  beforeAll(() => {
    process.env.DASHBOARD_ARTIFACT_STORE = "gcs";
    process.env.GCS_DASHBOARD_BUCKET = "bucket";
  });
  afterAll(() => {
    delete process.env.DASHBOARD_ARTIFACT_STORE;
    delete process.env.GCS_DASHBOARD_BUCKET;
  });

  it("writes only at the generation it read, and reports a lost race", async () => {
    expect(await catalogGeneration()).toBe(17);
    await writeCatalogIfUnchanged(emptyCatalog(), 17);
    expect(gcs.saves).toEqual([{ ifGenerationMatch: 17 }]);

    gcs.conflict = true;
    await expect(writeCatalogIfUnchanged(emptyCatalog(), 17)).rejects.toThrow(
      CatalogConflictError,
    );
  });
});
