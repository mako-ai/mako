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
import { resolveStripeRelease } from "./stripe-release";
import {
  authTypeOf,
  changelogFor,
  collectPublishedFiles,
  readExpectedRelease,
  readReleaseDir,
  uploadRelease,
  withVersion,
  writeReleaseDir,
} from "./publish";
import { bundleSourceHash } from "../bundle/source-hash";
import { connectorSdkVersion } from "../resolver";
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

describe("platform Stripe release", () => {
  const sha256 = "f".repeat(64);

  it("stays inactive without a pin", async () => {
    await expect(resolveStripeRelease({})).resolves.toBeNull();
  });

  it.each([{ version: "1.0.0" }, { sha256 }])(
    "refuses a partial pin",
    async pin => {
      await expect(
        resolveStripeRelease(pin, catalogWith("1.0.0")),
      ).rejects.toThrow(/both/);
    },
  );

  it.each(["1", "1.0", "^1.0.0", "1.0.0-beta", " 1.0.0 ", ""])(
    "refuses the nonexact version %s",
    async version => {
      await expect(
        resolveStripeRelease({ version, sha256 }, catalogWith("1.0.0")),
      ).rejects.toThrow(/exact version/);
    },
  );

  it.each(["", "f".repeat(63), "g".repeat(64), "F".repeat(64)])(
    "refuses an invalid digest",
    async digest => {
      await expect(
        resolveStripeRelease(
          { version: "1.0.0", sha256: digest },
          catalogWith("1.0.0"),
        ),
      ).rejects.toThrow(/SHA-256/);
    },
  );

  it("refuses a missing published version", async () => {
    await expect(
      resolveStripeRelease({ version: "1.0.0", sha256 }, catalogWith("1.0.1")),
    ).rejects.toThrow(/No version/);
  });

  it("refuses a different published digest", async () => {
    await expect(
      resolveStripeRelease(
        { version: "1.0.0", sha256: "a".repeat(64) },
        catalogWith("1.0.0"),
      ),
    ).rejects.toThrow(/reviewed SHA-256/);
  });

  it("returns only the exact reviewed published release", async () => {
    const resolved = await resolveStripeRelease(
      { version: "1.0.0", sha256 },
      catalogWith("1.0.0", "1.0.1", "2.0.0"),
    );
    expect(resolved).toMatchObject({
      ref: "mako/stripe@1.0.0",
      slug: "stripe",
      version: "1.0.0",
      hash: version("1.0.0").hash,
      sha256,
    });
  });
});

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
  it("never replaces a version with a different build", () => {
    const catalog = catalogWith("1.0.0");
    expect(() =>
      withVersion(catalog, {
        slug: "stripe",
        name: "stripe",
        versions: [version("1.0.0", "d".repeat(64))],
      }),
    ).toThrow(/immutable/);
    // The same build again is a no-op merge.
    expect(
      withVersion(catalog, {
        slug: "stripe",
        name: "stripe",
        versions: [version("1.0.0")],
      }).connectors.stripe.versions,
    ).toHaveLength(1);
  });

  it("resolves no Object.prototype name", () => {
    const parsed = parseRegistryReference("mako/constructor@1");
    if (!parsed.ok) throw new Error(parsed.reason);
    const resolved = resolveReference(parsed.value, catalogWith("1.0.0"));
    expect(!resolved.ok && resolved.reason).toContain(
      "no connector mako/constructor",
    );
  });

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

/** An in-memory GCS bucket honouring ifGenerationMatch, as GCS does. */
const gcs = vi.hoisted(() => ({
  objects: new Map<string, { bytes: Buffer; generation: number }>(),
  saves: [] as Array<{ key: string; ifGenerationMatch?: number }>,
  next: 1,
}));
vi.mock("@google-cloud/storage", async () => {
  const { Readable } = await import("node:stream");
  return {
    Storage: class {
      bucket() {
        return {
          file: (key: string) => ({
            getMetadata: async () => {
              const object = gcs.objects.get(key);
              if (!object) throw Object.assign(new Error("nf"), { code: 404 });
              return [
                {
                  generation: String(object.generation),
                  size: String(object.bytes.byteLength),
                },
              ];
            },
            createReadStream: () => {
              return Readable.from([
                gcs.objects.get(key)?.bytes ?? Buffer.alloc(0),
              ]);
            },
            save: async (
              bytes: Buffer,
              options: { preconditionOpts?: { ifGenerationMatch?: number } },
            ) => {
              const match = options.preconditionOpts?.ifGenerationMatch;
              gcs.saves.push({ key, ifGenerationMatch: match });
              const current = gcs.objects.get(key)?.generation ?? 0;
              if (match !== undefined && match !== current) {
                throw Object.assign(new Error("precondition"), { code: 412 });
              }
              gcs.objects.set(key, { bytes, generation: gcs.next++ });
            },
          }),
        };
      }
    },
  };
});

describe("the registry on GCS", () => {
  beforeAll(() => {
    process.env.CONNECTOR_REGISTRY_BUCKET = "registry-bucket";
  });
  afterAll(() => {
    delete process.env.CONNECTOR_REGISTRY_BUCKET;
  });

  it("writes the catalog only at the generation it read, and reports a lost race", async () => {
    expect(await catalogGeneration()).toBe(0);
    await writeCatalogIfUnchanged(emptyCatalog(), 0);
    const generation = await catalogGeneration();
    expect(gcs.saves.at(-1)).toMatchObject({ ifGenerationMatch: 0 });
    // Someone else writes in between.
    await writeCatalogIfUnchanged(emptyCatalog(), generation);
    await expect(
      writeCatalogIfUnchanged(emptyCatalog(), generation),
    ).rejects.toThrow(CatalogConflictError);
  });

  it("creates a bundle once, accepts the same bytes, and refuses different ones", async () => {
    const hash = "c".repeat(64);
    const source = {
      slug: "stripe",
      version: "1.0.0",
      hash,
      entry: "connector.ts",
      files: {},
    };
    const bytes = new TextEncoder().encode("export default 1;\n");
    expect(
      await writeRegistryArtifacts({
        slug: "stripe",
        hash,
        bundle: bytes,
        source,
      }),
    ).toEqual({ bundle: "created", source: "created" });
    const bundleSave = gcs.saves.find(save => save.key.endsWith(`${hash}.mjs`));
    expect(bundleSave?.ifGenerationMatch).toBe(0);

    expect(
      await writeRegistryArtifacts({
        slug: "stripe",
        hash,
        bundle: bytes,
        source,
      }),
    ).toEqual({ bundle: "matched", source: "matched" });

    await expect(
      writeRegistryArtifacts({
        slug: "stripe",
        hash,
        bundle: new TextEncoder().encode("export default 2;\n"),
        source,
      }),
    ).rejects.toThrow("Published objects are immutable");
    // The stored bundle is untouched.
    expect(
      gcs.objects
        .get(`connector-registry/stripe/bundles/${hash}.mjs`)
        ?.bytes.toString(),
    ).toBe("export default 1;\n");
  });

  it("uploads a release, and refuses another build under the same version inside the loop", async () => {
    const files = new Map([["connector.ts", new TextEncoder().encode("x")]]);
    const hash = bundleSourceHash({ files, sdkVersion: "0.1.0" });
    const release = (code: string) => {
      const bytes = new TextEncoder().encode(code);
      const record = {
        ...version("3.0.0", hash),
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      };
      return {
        record,
        bundle: bytes,
        entry: { slug: "uploaded", name: "uploaded", versions: [record] },
        source: {
          slug: "uploaded",
          version: "3.0.0",
          hash,
          entry: "connector.ts",
          files: { "connector.ts": Buffer.from("x").toString("base64") },
        },
      };
    };
    const first = await uploadRelease(release("export default 1;"));
    expect(first.published).toBe(true);
    const again = await uploadRelease(release("export default 1;"));
    expect(again.alreadyPublished).toBe(true);
    await expect(uploadRelease(release("export default 2;"))).rejects.toThrow(
      /immutable/,
    );
    const catalog = await readCatalog();
    expect(catalog.connectors.uploaded.versions).toHaveLength(1);
  });
});

describe("the release directory between the two jobs", () => {
  it("round-trips, and refuses a tampered bundle, source or manifest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-dir-"));
    try {
      const files = new Map([["connector.ts", new TextEncoder().encode("x")]]);
      const hash = bundleSourceHash({ files, sdkVersion: "0.1.0" });
      const bytes = new TextEncoder().encode("export default 1;");
      const record = {
        ...version("1.0.0", hash),
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      };
      const written = await writeReleaseDir(dir, {
        record,
        bundle: bytes,
        entry: { slug: "stripe", name: "stripe", versions: [record] },
        source: {
          slug: "stripe",
          version: "1.0.0",
          hash,
          entry: "connector.ts",
          files: { "connector.ts": Buffer.from("x").toString("base64") },
        },
      });
      expect((await readReleaseDir(written)).record.hash).toBe(hash);

      await fs.appendFile(path.join(written, "bundle.mjs"), "\n// extra");
      await expect(readReleaseDir(written)).rejects.toThrow("bundle sha256");
      await fs.writeFile(path.join(written, "bundle.mjs"), bytes);

      // A manifest edited to match a changed source still fails: the source
      // hash is recomputed from the files.
      const sourcePath = path.join(written, "source.json");
      const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
      source.files["connector.ts"] = Buffer.from("y").toString("base64");
      const changed = Buffer.from(JSON.stringify(source));
      await fs.writeFile(sourcePath, changed);
      const manifestPath = path.join(written, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      manifest.sourceSha256 = sha256Hex(changed);
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await expect(readReleaseDir(written)).rejects.toThrow(
        "source hash recomputed",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the publish job accepts only the tagged release", () => {
  it("refuses another connector, a second directory, and a source that is not the folder's", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "expected-release-"));
    try {
      const folder = path.join(tmp, "connectors", "stripe");
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "connector.ts"), "x");
      const files = await collectPublishedFiles(folder);
      const sdkVersion = await connectorSdkVersion();
      const write = async (
        root: string,
        slug: string,
        sourceFiles: Map<string, Uint8Array>,
      ) => {
        const hash = bundleSourceHash({ files: sourceFiles, sdkVersion });
        const bytes = new TextEncoder().encode("export default 1;");
        const record = {
          ...version("1.0.0", hash),
          sha256: sha256Hex(bytes),
          bytes: bytes.byteLength,
          sdkVersion,
          commit: "a".repeat(40),
        };
        await writeReleaseDir(root, {
          record,
          bundle: bytes,
          entry: { slug, name: slug, versions: [record] },
          source: {
            slug,
            version: "1.0.0",
            hash,
            entry: "connector.ts",
            files: Object.fromEntries(
              [...sourceFiles].map(([n, b]) => [
                n,
                Buffer.from(b).toString("base64"),
              ]),
            ),
          },
        });
      };
      const expect_ = (root: string) =>
        readExpectedRelease({
          root,
          slug: "stripe",
          version: "1.0.0",
          commit: "a".repeat(40),
          folder,
        });

      const good = path.join(tmp, "good");
      await write(good, "stripe", files);
      expect((await expect_(good)).entry.slug).toBe("stripe");

      // A build of connector-foo that slips in a stripe release.
      const smuggled = path.join(tmp, "smuggled");
      await write(smuggled, "stripe", files);
      await write(smuggled, "foo", files);
      await expect(expect_(smuggled)).rejects.toThrow("exactly stripe-1.0.0/");

      const other = path.join(tmp, "other");
      await write(other, "foo", files);
      await expect(expect_(other)).rejects.toThrow("exactly stripe-1.0.0/");

      const altered = path.join(tmp, "altered");
      await write(
        altered,
        "stripe",
        new Map([["connector.ts", new TextEncoder().encode("evil")]]),
      );
      await expect(expect_(altered)).rejects.toThrow(
        "differs from connectors/stripe/",
      );

      await expect(
        readExpectedRelease({
          root: good,
          slug: "stripe",
          version: "1.0.0",
          commit: "b".repeat(40),
          folder,
        }),
      ).rejects.toThrow("not the tagged");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
