/**
 * The ontology lookups end to end: find_models, describe_model, lookup_term
 * and model_readers against a real bare workspace repo (apps with bindings,
 * the registry file), in-memory Mongo (the dbt project and its runs) and an
 * in-memory artifact store holding a manifest and a catalog.
 *
 * The claims under test:
 *
 *  - the manifest read is the project's last PRODUCTION one, parsed once per
 *    version, and a workspace without one says so instead of failing;
 *  - the registry comes from `dbt/ontology/terms.yml` on main; absent or
 *    malformed, every tool still answers, with an empty registry and why;
 *  - readers come from app bindings on main, and a private app's readers
 *    never reach another user;
 *  - the tools are part of createDbtServerTools (the factory the in-product
 *    agent and the MCP server share).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const stored = vi.hoisted(() => new Map<string, Buffer>());
const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    openReadStream: async (key: string) => {
      const { Readable } = await import("node:stream");
      const body = stored.get(key);
      if (!body) return null;
      reads.count++;
      return Readable.from([body]);
    },
  }),
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { createDbtServerTools } from "./dbt-tools";
import { createDbtOntologyTools } from "./dbt-ontology-tools";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  DbtProject,
  DbtRun,
  WorkspaceUserHandle,
} from "../../database/workspace-schema";
import {
  commitBlobsOnBranch,
  DEFAULT_BRANCH,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../../apps/app-index.service";
import { invalidateOwnerDirectory } from "../../apps/user-handles.service";
import { clearManifestIndexCache } from "../../dbt/ontology/manifest-index.service";
import { clearOntologyRegistryCache } from "../../dbt/ontology/registry.service";
import {
  ONTOLOGY_RAW_RELATIONSHIPS_PATH,
  ONTOLOGY_REGISTRY_PATH,
} from "../../dbt/ontology/registry";
import {
  ONTOLOGY_GRAPH_YAML,
  ONTOLOGY_RAW_RELATIONSHIPS_YAML,
  ONTOLOGY_CATALOG,
  ONTOLOGY_MANIFEST,
  ONTOLOGY_REGISTRY_YAML,
} from "../../dbt/test-support/ontology-fixtures";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const ANA = new Types.ObjectId().toString();
const BOB = new Types.ObjectId().toString();

const manifest = (title: string) =>
  `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`;

const APP_FILES: Record<string, string> = {
  "README.md": "workspace\n",
  "apps/finance/mrr/mako.json": manifest("MRR"),
  "apps/finance/mrr/bindings/mrr.sql":
    "-- connection: c1\nselect * from {{ dbt_schema }}.fct_account_product_month\n",
  "apps/finance/mrr/bindings/accounts.sql":
    "-- connection: c1\nselect * from `acme-prod.{{ dbt_schema }}.dim_account` a\njoin `acme-prod`.`crm_public`.`organisations` o using (id)\n",
  "apps/sales/accounts/mako.json": manifest("Accounts"),
  "apps/sales/accounts/bindings/rows.sql":
    "-- connection: c1\nselect * from dbt_prod.dim_account\njoin analytics_legacy.orders using (account_id)\n",
  "users/ana/apps/scratch/mako.json": manifest("Scratch"),
  "users/ana/apps/scratch/bindings/q.sql":
    "-- connection: c1\nselect * from {{ dbt_schema }}.dim_account\n",
};

type Exec<I, O> = (input: I) => Promise<O>;
const run = <O = Record<string, unknown>>(
  tool: { execute?: unknown },
  input: Record<string, unknown>,
): Promise<O> => (tool.execute as Exec<Record<string, unknown>, O>)(input);

async function commit(writes: Record<string, string>, deletes: string[] = []) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "test: change" },
  );
}

/** A dbt project whose last prod build stored the fixture manifest. */
async function seedProject(
  options: { prod?: boolean; catalog?: boolean } = {},
) {
  const { prod = true, catalog = true } = options;
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "prod",
        connectionId: CONN,
        targetSchema: "dbt_prod",
        threads: 4,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: "tester",
    ...(prod ? { lastProdManifestKey: "runs/1/manifest.json" } : {}),
  });
  stored.set(
    "runs/1/manifest.json",
    Buffer.from(JSON.stringify(ONTOLOGY_MANIFEST)),
  );
  if (catalog) {
    stored.set(
      "runs/1/catalog.json",
      Buffer.from(JSON.stringify(ONTOLOGY_CATALOG)),
    );
  }
  await DbtRun.collection.insertOne({
    workspaceId: new Types.ObjectId(WS),
    projectId: project._id,
    status: "success",
    createdAt: new Date(),
    artifactKeys: {
      manifest: "runs/1/manifest.json",
      ...(catalog ? { catalog: "runs/1/catalog.json" } : {}),
    },
  });
  return project;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-ontology-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    AppIndexEntry.deleteMany({}),
    AppIndexHead.deleteMany({}),
    AppProject.deleteMany({}),
    WorkspaceUserHandle.deleteMany({}),
  ]);
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: ANA,
    handle: "ana",
  });
  stored.clear();
  reads.count = 0;
  clearManifestIndexCache();
  clearOntologyRegistryCache();
  invalidateOwnerDirectory();
  invalidateAppsIndexCache();
  await unbindTestWorkspaceRepo(WS);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    ...APP_FILES,
    [ONTOLOGY_REGISTRY_PATH]: ONTOLOGY_REGISTRY_YAML,
  });
  await bindTestWorkspaceRepo(WS);
});

const tools = createDbtOntologyTools(WS, ANA);

describe("wiring", () => {
  it("ships the four tools in the shared dbt tool factory", () => {
    const names = Object.keys(createDbtServerTools(WS, ANA));
    expect(names).toEqual(
      expect.arrayContaining([
        "find_models",
        "describe_model",
        "lookup_term",
        "model_readers",
        "find_join_path",
      ]),
    );
  });
});

describe("find_models", () => {
  it("ranks the canonical model of a matched term first, with its facts", async () => {
    await seedProject();
    const result = await run<{
      success: boolean;
      total: number;
      results: Array<Record<string, unknown>>;
      matchedTerms: unknown[];
      manifests: Array<Record<string, unknown>>;
      registry?: unknown;
    }>(tools.find_models, { query: "monthly recurring revenue" });
    expect(result.success).toBe(true);
    expect(result.results[0]).toEqual({
      name: "fct_account_product_month",
      resourceType: "model",
      layer: "marts",
      path: "models/marts/finance/fct_account_product_month.sql",
      description:
        "Monthly recurring revenue per account and product. Grain: account x product x month.",
      grain: "account x product x month",
      access: "public",
      group: "finance",
      materialized: "table",
      relation: "`acme-prod`.`dbt_prod`.`fct_account_product_month`",
      columnCount: 5,
      matchedOn: expect.arrayContaining(["registry", "description"]),
      readerApps: 1,
      canonicalFor: [{ kind: "term", name: "mrr", column: "mrr_eur" }],
    });
    expect(result.matchedTerms).toEqual([
      {
        kind: "term",
        name: "mrr",
        canonicalModel: "fct_account_product_month",
      },
    ]);
    expect(result.manifests).toEqual([
      expect.objectContaining({
        project: "Analytics",
        source: "prod",
        generatedAt: "2026-11-12T04:00:00Z",
      }),
    ]);
    expect(result.registry).toBeUndefined();
  });

  it("puts a canonical model above a better word match", async () => {
    await seedProject();
    // "mrr" is a column of the variant model and the name of the term.
    const result = await run<{ results: Array<Record<string, unknown>> }>(
      tools.find_models,
      { query: "mrr" },
    );
    const names = result.results.map(r => r.name);
    expect(names[0]).toBe("fct_account_product_month");
    const variant = result.results.find(
      r => r.name === "int_fr_renewals__contract_periods",
    );
    expect(variant?.variantOf).toEqual([
      { term: "mrr", canonicalModel: "fct_account_product_month" },
    ]);
  });

  it("finds the canonical model through a loosely spelled term", async () => {
    await seedProject();
    const result = await run<{ results: Array<Record<string, unknown>> }>(
      tools.find_models,
      { query: "paying customers" },
    );
    expect(result.results[0].name).toBe("dim_account");
    expect(result.results[0].canonicalFor).toEqual([
      { kind: "term", name: "paying_customer", column: "is_paying" },
      { kind: "entity", name: "account", primaryKey: "account_id" },
    ]);
  });

  it("filters by layer and caps the list, saying so", async () => {
    await seedProject();
    const sources = await run<{ results: Array<Record<string, unknown>> }>(
      tools.find_models,
      { query: "subscriptions", layer: "source" },
    );
    expect(sources.results.map(r => r.name)).toEqual(["stripe.subscriptions"]);
    const capped = await run<{
      results: unknown[];
      total: number;
      truncated?: boolean;
      note?: string;
    }>(tools.find_models, { query: "account", limit: 1 });
    expect(capped.results).toHaveLength(1);
    expect(capped.total).toBeGreaterThan(1);
    expect(capped.truncated).toBe(true);
    expect(capped.note).toContain(`Showing 1 of ${capped.total}`);
  });

  it("counts only the apps the caller can see", async () => {
    await seedProject();
    const count = async (userId: string) => {
      const result = await run<{ results: Array<Record<string, unknown>> }>(
        createDbtOntologyTools(WS, userId).find_models,
        { query: "dim_account" },
      );
      return result.results.find(r => r.name === "dim_account")?.readerApps;
    };
    // Two shared apps read it, plus Ana's private scratch app.
    expect(await count(ANA)).toBe(3);
    expect(await count(BOB)).toBe(2);
  });

  it("answers with an empty list and a message when no manifest is stored", async () => {
    const result = await run<{
      success: boolean;
      results: unknown[];
      message: string;
    }>(tools.find_models, { query: "revenue" });
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.message).toContain("No dbt manifest");
  });

  it("falls back to the latest run when prod was never built, and says so", async () => {
    await seedProject({ prod: false });
    const result = await run<{
      results: unknown[];
      manifests: Array<Record<string, unknown>>;
    }>(tools.find_models, { query: "account" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.manifests[0]).toMatchObject({ source: "latest-run" });
    expect(result.manifests[0].note).toContain("No production build yet");
  });

  it("parses a manifest once per version", async () => {
    const project = await seedProject();
    await run(tools.find_models, { query: "account" });
    await run(tools.describe_model, { name: "dim_account" });
    await run(tools.model_readers, { name: "dim_account" });
    // One manifest + one catalog, read once.
    expect(reads.count).toBe(2);

    // A new prod build is a new key: parsed again, once.
    stored.set(
      "runs/2/manifest.json",
      Buffer.from(JSON.stringify({ ...ONTOLOGY_MANIFEST, sources: {} })),
    );
    await DbtProject.updateOne(
      { _id: project._id },
      { $set: { lastProdManifestKey: "runs/2/manifest.json" } },
    );
    const after = await run<{ results: Array<Record<string, unknown>> }>(
      tools.find_models,
      { query: "subscriptions", layer: "source" },
    );
    expect(after.results).toEqual([]);
    await run(tools.find_models, { query: "account" });
    // The new run stored no catalog, and another run's is never borrowed.
    expect(reads.count).toBe(3);
    const described = await run<{ columnTypesFrom: string }>(
      tools.describe_model,
      { name: "fct_account_product_month" },
    );
    expect(described.columnTypesFrom).toBe("manifest");
  });
});

describe("describe_model", () => {
  it("returns the full record of a model", async () => {
    await seedProject();
    const result = await run(tools.describe_model, {
      name: "fct_account_product_month",
    });
    expect(result).toEqual({
      success: true,
      name: "fct_account_product_month",
      resourceType: "model",
      uniqueId: "model.analytics.fct_account_product_month",
      layer: "marts",
      path: "models/marts/finance/fct_account_product_month.sql",
      description:
        "Monthly recurring revenue per account and product. Grain: account x product x month.",
      grain: "account x product x month",
      materialized: "table",
      relation: "`acme-prod`.`dbt_prod`.`fct_account_product_month`",
      access: "public",
      group: "finance",
      contract: { enforced: true },
      tags: ["finance", "governed"],
      meta: { owner: "finance" },
      columns: [
        {
          name: "account_id",
          type: "STRING",
          description: "The paying account.",
          tests: ["not_null"],
        },
        {
          name: "product",
          type: "STRING",
          description: "Subscription product.",
        },
        { name: "month", type: "DATE" },
        {
          name: "mrr_eur",
          type: "NUMERIC",
          description: "Monthly recurring revenue in EUR, VAT excluded.",
        },
        { name: "loaded_at", type: "TIMESTAMP" },
      ],
      columnCount: 5,
      columnTypesFrom: "catalog",
      tests: ["dbt_utils.unique_combination_of_columns"],
      upstream: ["dim_account", "int_subscriptions__periods"],
      downstream: [],
      exposures: [
        {
          name: "Finance dashboard",
          type: "dashboard",
          url: "https://example.test/finance",
          owner: "Finance",
        },
      ],
      readers: {
        apps: 1,
        items: [
          {
            app: expect.any(String),
            title: "MRR",
            path: "apps/finance/mrr",
            bindings: ["apps/finance/mrr/bindings/mrr.sql"],
          },
        ],
      },
      canonicalFor: [{ kind: "term", name: "mrr", column: "mrr_eur" }],
      manifest: {
        project: "Analytics",
        projectId: expect.any(String),
        source: "prod",
        generatedAt: "2026-11-12T04:00:00Z",
      },
    });
  });

  it("warns when the model is a known variant, naming the canonical model", async () => {
    await seedProject();
    const result = await run<{ warnings: string[]; variantOf: unknown[] }>(
      tools.describe_model,
      { name: "int_fr_renewals__contract_periods" },
    );
    expect(result.warnings).toEqual([
      "This model is a known variant of the term `mrr`. The canonical model is `fct_account_product_month` (column `mrr_eur`): read that one unless the difference is what you need. Difference: Contract MRR, VAT included, France only.",
    ]);
    expect(result.variantOf).toEqual([
      {
        term: "mrr",
        canonicalModel: "fct_account_product_month",
        canonicalColumn: "mrr_eur",
        difference: "Contract MRR, VAT included, France only.",
      },
    ]);
  });

  it("describes a source by name and by warehouse relation", async () => {
    await seedProject();
    for (const name of ["crm.organisations", "crm_public.organisations"]) {
      const result = await run<Record<string, unknown>>(tools.describe_model, {
        name,
      });
      expect(result).toMatchObject({
        success: true,
        name: "crm.organisations",
        resourceType: "source",
        layer: "source",
        downstream: ["dim_account"],
        readers: { apps: 1 },
      });
    }
  });

  it("uses the manifest's types when no catalog was stored", async () => {
    await seedProject({ catalog: false });
    const result = await run<{
      columnTypesFrom: string;
      columns: Array<{ name: string; type?: string }>;
    }>(tools.describe_model, { name: "fct_account_product_month" });
    expect(result.columnTypesFrom).toBe("manifest");
    expect(result.columns.map(c => c.name)).toEqual([
      "account_id",
      "product",
      "month",
      "mrr_eur",
    ]);
    expect(result.columns[2].type).toBe("date");
  });

  it("suggests close names for an unknown model", async () => {
    await seedProject();
    const result = await run<{
      success: boolean;
      error: string;
      suggestions: string[];
    }>(tools.describe_model, { name: "fct_account" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('"fct_account"');
    expect(result.suggestions).toContain("fct_account_product_month");
  });

  it("fails cleanly without a manifest", async () => {
    const result = await run<{ success: boolean; error: string }>(
      tools.describe_model,
      { name: "dim_account" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No dbt manifest");
  });

  it("caps the columns of a wide model and says so", async () => {
    await seedProject();
    const columns = Object.fromEntries(
      Array.from({ length: 260 }, (_, i) => [
        `c${i}`,
        { name: `c${i}`, description: "word ".repeat(200) },
      ]),
    );
    stored.set(
      "runs/1/manifest.json",
      Buffer.from(
        JSON.stringify({
          nodes: {
            "model.analytics.wide": {
              name: "wide",
              resource_type: "model",
              description: "word ".repeat(1000),
              columns,
            },
          },
        }),
      ),
    );
    const result = await run<{
      description: string;
      columnCount: number;
      columnsTruncated: boolean;
      columns: Array<{ description: string }>;
    }>(tools.describe_model, { name: "wide" });
    expect(result.columnCount).toBe(260);
    expect(result.columns).toHaveLength(200);
    expect(result.columnsTruncated).toBe(true);
    expect(result.description).toMatch(/… \[truncated\]$/);
    expect(result.columns[0].description).toMatch(/… \[truncated\]$/);
    expect(JSON.stringify(result).length).toBeLessThan(80_000);
  });
});

describe("lookup_term", () => {
  it("resolves a term by synonym with everything the registry holds", async () => {
    const result = await run(tools.lookup_term, {
      query: "Monthly Recurring Revenue",
    });
    expect(result).toEqual({
      success: true,
      matches: [
        {
          kind: "term",
          name: "mrr",
          label: "MRR",
          definition:
            "Monthly recurring revenue: the monthly value of active subscriptions, in EUR, VAT excluded.",
          owner: "finance",
          synonyms: ["monthly recurring revenue"],
          status: "governed",
          canonical: { model: "fct_account_product_month", column: "mrr_eur" },
          grain: "account x product x month",
          knownVariants: [
            {
              model: "int_fr_renewals__contract_periods",
              difference: "Contract MRR, VAT included, France only.",
            },
          ],
          forbiddenPatterns: [
            {
              regex: "sum\\(.*amount.*\\)\\s*/\\s*12",
              message: "Read mrr_eur from fct_account_product_month.",
              paths: ["dbt/models/**", "apps/**/bindings/**"],
            },
          ],
          matchedOn: "synonym",
          score: 1,
        },
      ],
      next: expect.stringContaining("describe_model"),
    });
  });

  it("resolves plurals and entities", async () => {
    const paying = await run<{ matches: Array<Record<string, unknown>> }>(
      tools.lookup_term,
      { query: "paying customers" },
    );
    expect(paying.matches[0]).toMatchObject({
      kind: "term",
      name: "paying_customer",
      status: "draft",
      canonical: { model: "dim_account", column: "is_paying" },
    });
    const account = await run<{ matches: Array<Record<string, unknown>> }>(
      tools.lookup_term,
      { query: "ACCOUNT" },
    );
    expect(account.matches[0]).toMatchObject({
      kind: "entity",
      name: "account",
      canonical: { model: "dim_account", primaryKey: "account_id" },
      sources: ["crm_public.organisations"],
    });
  });

  it("returns the closest names and points to find_models on no match", async () => {
    const result = await run<{
      success: boolean;
      matches: unknown[];
      closest: string[];
      suggestion: string;
    }>(tools.lookup_term, { query: "listing price" });
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.closest.sort()).toEqual([
      "account",
      "mrr",
      "paying_customer",
    ]);
    expect(result.suggestion).toContain(
      'find_models({ query: "listing price" })',
    );
  });

  it("answers with an empty registry when the file is absent", async () => {
    await commit({}, [ONTOLOGY_REGISTRY_PATH]);
    const result = await run<{
      success: boolean;
      matches: unknown[];
      closest: string[];
      registry: { status: string; message: string };
    }>(tools.lookup_term, { query: "mrr" });
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.closest).toEqual([]);
    expect(result.registry.status).toBe("absent");
    expect(result.registry.message).toContain(ONTOLOGY_REGISTRY_PATH);
  });

  it("answers with an empty registry when the file is malformed", async () => {
    await commit({ [ONTOLOGY_REGISTRY_PATH]: "terms:\n  - name: [unclosed\n" });
    const result = await run<{
      success: boolean;
      matches: unknown[];
      registry: { status: string; message: string };
    }>(tools.lookup_term, { query: "mrr" });
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.registry.status).toBe("malformed");
    expect(result.registry.message).toContain("could not be parsed");
  });

  it("answers with an empty registry when the workspace has no repo", async () => {
    await unbindTestWorkspaceRepo(WS);
    const result = await run<{
      success: boolean;
      matches: unknown[];
      registry: { status: string };
    }>(tools.lookup_term, { query: "mrr" });
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.registry.status).toBe("absent");
  });

  it("reads the registry again when main moves", async () => {
    const before = await run<{ matches: unknown[] }>(tools.lookup_term, {
      query: "churn",
    });
    expect(before.matches).toEqual([]);
    await commit({
      [ONTOLOGY_REGISTRY_PATH]:
        "version: 1\nterms:\n  - name: churn\n    definition: Lost accounts.\n",
    });
    const after = await run<{ matches: Array<Record<string, unknown>> }>(
      tools.lookup_term,
      { query: "churn" },
    );
    expect(after.matches[0]).toMatchObject({
      name: "churn",
      definition: "Lost accounts.",
    });
  });
});

describe("find_models and describe_model without a registry", () => {
  it("still search and describe, and say the registry is absent", async () => {
    await seedProject();
    await commit({}, [ONTOLOGY_REGISTRY_PATH]);
    const found = await run<{
      success: boolean;
      results: Array<Record<string, unknown>>;
      registry: { status: string };
    }>(tools.find_models, { query: "recurring revenue" });
    expect(found.success).toBe(true);
    expect(found.results[0].name).toBe("fct_account_product_month");
    expect(found.results[0].canonicalFor).toBeUndefined();
    expect(found.registry.status).toBe("absent");

    const described = await run<Record<string, unknown>>(tools.describe_model, {
      name: "int_fr_renewals__contract_periods",
    });
    expect(described.success).toBe(true);
    expect(described.warnings).toBeUndefined();
    expect(described.registry).toMatchObject({ status: "absent" });
  });
});

describe("model_readers", () => {
  it("lists apps and binding files for a model, however bindings name it", async () => {
    await seedProject();
    const result = await run(tools.model_readers, { name: "dim_account" });
    expect(result).toEqual({
      success: true,
      name: "dim_account",
      resolvedAs: {
        kind: "dbt",
        resourceType: "model",
        relation: "`acme-prod`.`dbt_prod`.`dim_account`",
      },
      apps: 3,
      bindings: 3,
      readers: [
        {
          app: expect.any(String),
          title: "MRR",
          path: "apps/finance/mrr",
          // `acme-prod.{{ dbt_schema }}.dim_account`, backticked.
          bindings: ["apps/finance/mrr/bindings/accounts.sql"],
        },
        {
          app: expect.any(String),
          title: "Accounts",
          path: "apps/sales/accounts",
          // Plain `dbt_prod.dim_account`.
          bindings: ["apps/sales/accounts/bindings/rows.sql"],
        },
        {
          app: expect.any(String),
          title: "Scratch",
          path: "users/ana/apps/scratch",
          // `{{ dbt_schema }}.dim_account`.
          bindings: ["users/ana/apps/scratch/bindings/q.sql"],
        },
      ],
      downstreamModels: 1,
    });
  });

  it("names the first 5 bindings of an app and counts the rest", async () => {
    await seedProject();
    await commit(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `apps/finance/mrr/bindings/extra_${i}.sql`,
          "-- connection: c1\nselect * from {{ dbt_schema }}.dim_account\n",
        ]),
      ),
    );
    const result = await run<{
      bindings: number;
      readers: Array<{
        path: string;
        bindings: string[];
        bindingCount?: number;
      }>;
    }>(tools.model_readers, { name: "dim_account" });
    const mrr = result.readers.find(r => r.path === "apps/finance/mrr");
    expect(mrr?.bindings).toHaveLength(5);
    expect(mrr?.bindingCount).toBe(9);
    expect(result.bindings).toBe(11);
  });

  it("hides a private app's readers from another user", async () => {
    await seedProject();
    const result = await run<{
      apps: number;
      readers: Array<{ path: string }>;
    }>(createDbtOntologyTools(WS, BOB).model_readers, { name: "dim_account" });
    expect(result.apps).toBe(2);
    expect(result.readers.map(r => r.path)).toEqual([
      "apps/finance/mrr",
      "apps/sales/accounts",
    ]);
  });

  it("resolves a warehouse relation back to its dbt node", async () => {
    await seedProject();
    const result = await run<Record<string, unknown>>(tools.model_readers, {
      name: "`acme-prod`.`crm_public`.`organisations`",
    });
    expect(result).toMatchObject({
      name: "crm.organisations",
      resolvedAs: { kind: "dbt", resourceType: "source" },
      apps: 1,
      readers: [
        {
          path: "apps/finance/mrr",
          bindings: ["apps/finance/mrr/bindings/accounts.sql"],
        },
      ],
    });
  });

  it("matches a raw table no dbt node describes, with or without a manifest", async () => {
    for (const withManifest of [true, false]) {
      await DbtProject.deleteMany({});
      clearManifestIndexCache();
      if (withManifest) await seedProject();
      const result = await run<Record<string, unknown>>(tools.model_readers, {
        name: "analytics_legacy.orders",
      });
      expect(result).toMatchObject({
        success: true,
        resolvedAs: { kind: "table", relation: "analytics_legacy.orders" },
        apps: 1,
        bindings: 1,
        readers: [
          {
            path: "apps/sales/accounts",
            bindings: ["apps/sales/accounts/bindings/rows.sql"],
          },
        ],
      });
      expect(result.note).toContain("not a dbt node");
    }
  });

  it("still finds templated readers when no manifest holds the model", async () => {
    // No dbt project at all: the manifest cannot say what `dim_account` is.
    const result = await run<{
      apps: number;
      readers: Array<{ path: string }>;
      note: string;
    }>(tools.model_readers, { name: "dim_account" });
    expect(result.readers.map(r => r.path)).toEqual([
      "apps/finance/mrr",
      "users/ana/apps/scratch",
    ]);
    expect(result.note).toContain("no dbt manifest could be read");
  });

  it("reports no readers for a model nothing reads, and for a bare unknown name", async () => {
    await seedProject();
    const seed = await run<Record<string, unknown>>(tools.model_readers, {
      name: "country_codes",
    });
    expect(seed).toMatchObject({ success: true, apps: 0, readers: [] });
    const bare = await run<Record<string, unknown>>(tools.model_readers, {
      name: "orders",
    });
    expect(bare).toMatchObject({ success: true, apps: 0, readers: [] });
    expect(bare.note).toContain('pass "dataset.table"');
    expect(bare.note).toContain("None found");
  });

  it("follows main: a new binding is a new reader", async () => {
    await seedProject();
    await commit({
      "apps/ops/codes/mako.json": manifest("Codes"),
      "apps/ops/codes/bindings/codes.sql":
        "-- connection: c1\nselect * from {{dbt_schema}}.country_codes\n",
    });
    const result = await run<{
      apps: number;
      readers: Array<{ path: string }>;
    }>(tools.model_readers, { name: "country_codes" });
    expect(result.apps).toBe(1);
    expect(result.readers[0].path).toBe("apps/ops/codes");
  });
});

describe("find_join_path", () => {
  const withGraph = () =>
    commit({
      [ONTOLOGY_REGISTRY_PATH]: ONTOLOGY_GRAPH_YAML,
      [ONTOLOGY_RAW_RELATIONSHIPS_PATH]: ONTOLOGY_RAW_RELATIONSHIPS_YAML,
    });

  it("returns the declared path between two entities, hop by hop", async () => {
    await withGraph();
    const result = await run<{
      success: boolean;
      level: string;
      paths: Array<{
        hops: number;
        governed: boolean;
        fanOut: boolean;
        steps: Array<Record<string, unknown>>;
      }>;
      registry?: unknown;
    }>(tools.find_join_path, { from: "subscription", to: "customer" });
    expect(result.success).toBe(true);
    expect(result.level).toBe("entity");
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({
      hops: 2,
      governed: true,
      fanOut: false,
    });
    expect(result.paths[0].steps.map(step => step.on)).toEqual([
      "stg_stripe__subscriptions.customer_id = int_crm__customer_account.customer_id",
      "int_crm__customer_account.account_key = dim_account.account_key",
    ]);
    // The generated file skipped 1 record: said, not hidden.
    expect(result.registry).toEqual({
      status: "ok",
      problems: [expect.stringContaining("1 of 7 records were skipped")],
    });
  });

  it("resolves a warehouse relation through the manifest", async () => {
    await withGraph();
    await seedProject();
    const result = await run<{
      from: Record<string, unknown>;
      paths: Array<{ steps: Array<{ fanOut?: string }> }>;
    }>(tools.find_join_path, {
      from: "`acme-prod`.`dbt_prod`.`dim_account`",
      to: "stripe_customer",
    });
    expect(result.from).toMatchObject({
      kind: "entity",
      entity: "account",
      matchedOn: "model",
    });
    expect(result.paths[0].steps[0].fanOut).toContain(
      "One account row matches many stripe_customer rows",
    );
  });

  it("falls back to raw tables, and works without the generated file", async () => {
    await withGraph();
    const raw = await run<{ level: string; paths: unknown[] }>(
      tools.find_join_path,
      { from: "crm_public.users", to: "crm_public.organisations", maxHops: 3 },
    );
    expect(raw.level).toBe("raw");
    expect(raw.paths).toHaveLength(1);

    await commit({}, [ONTOLOGY_RAW_RELATIONSHIPS_PATH]);
    const without = await run<{
      success: boolean;
      level: string;
      from: { kind: string };
    }>(tools.find_join_path, {
      from: "crm_public.users",
      to: "crm_public.organisations",
    });
    expect(without.success).toBe(true);
    expect(without.level).toBe("none");
    expect(without.from.kind).toBe("unknown");
    const entity = await run<{ level: string }>(tools.find_join_path, {
      from: "subscription",
      to: "account",
    });
    expect(entity.level).toBe("entity");
  });

  it("says when there is no path, with the nearest entities", async () => {
    await withGraph();
    const result = await run<{
      success: boolean;
      paths: unknown[];
      message: string;
      nearest: { from: string[]; to: string[] };
    }>(tools.find_join_path, { from: "ad_campaign", to: "account" });
    expect(result.success).toBe(true);
    expect(result.paths).toEqual([]);
    expect(result.message).toContain("No declared path connects these two");
    expect(result.nearest.to).toContain("stripe_customer");
  });

  it("answers on a registry without relationships, absent or malformed", async () => {
    // The first schema: entities, no relationships.
    const first = await run<{ success: boolean; level: string }>(
      tools.find_join_path,
      { from: "account", to: "mrr" },
    );
    expect(first).toMatchObject({ success: true, level: "none" });

    await commit({ [ONTOLOGY_REGISTRY_PATH]: "relationships: [unclosed\n" });
    const malformed = await run<{
      success: boolean;
      paths: unknown[];
      registry: { status: string };
    }>(tools.find_join_path, { from: "account", to: "subscription" });
    expect(malformed.success).toBe(true);
    expect(malformed.paths).toEqual([]);
    expect(malformed.registry.status).toBe("malformed");

    await commit({}, [ONTOLOGY_REGISTRY_PATH]);
    const absent = await run<{
      success: boolean;
      message: string;
      registry: { status: string };
    }>(tools.find_join_path, { from: "account", to: "subscription" });
    expect(absent.success).toBe(true);
    expect(absent.message).toContain("declares no entities");
    expect(absent.registry.status).toBe("absent");
  });
});

describe("entities in lookup_term and describe_model", () => {
  const withGraph = () =>
    commit({ [ONTOLOGY_REGISTRY_PATH]: ONTOLOGY_GRAPH_YAML });

  it("lookup_term shows an entity's key, identities and relationships", async () => {
    await withGraph();
    const result = await run<{ matches: Array<Record<string, unknown>> }>(
      tools.lookup_term,
      { query: "account" },
    );
    expect(result.matches[0]).toMatchObject({
      kind: "entity",
      name: "account",
      status: "governed",
      canonical: { model: "dim_account", primaryKey: "account_key" },
      grain: "one row per CRM organisation with at least one Stripe customer",
      identities: [
        { system: "crm", column: "organisation_id", resolver: "dim_account" },
        {
          system: "stripe",
          column: "customer_id",
          resolver: "int_crm__customer_account",
        },
        { system: "close", column: "close_lead_id" },
      ],
      knownVariants: [
        {
          model: "int_fr_renewals__identity",
          difference: "FR only. Maps a Stripe customer to a Close lead.",
        },
      ],
    });
    const relationships = result.matches[0].relationships as Array<{
      relationship: string;
      with: string;
      cardinality: string;
    }>;
    expect(relationships.map(r => `${r.with}:${r.cardinality}`)).toEqual([
      "crm_user:many_to_one",
      "organisation:one_to_one",
      "stripe_customer:one_to_many",
      "close_lead:many_to_one",
      "tag:many_to_many",
    ]);
  });

  it("lookup_term shows a draft entity's open point and composite key", async () => {
    await withGraph();
    const result = await run<{ matches: Array<Record<string, unknown>> }>(
      tools.lookup_term,
      { query: "demo" },
    );
    expect(result.matches[0]).toMatchObject({
      name: "demo",
      status: "draft",
      canonical: {
        model: "fct_intl_sales_demos",
        primaryKey: ["country", "demo_key"],
      },
      openPoint: "The demo key is per country.",
    });
  });

  it("describe_model shows the entity a model is canonical for, and how it joins", async () => {
    await withGraph();
    await seedProject();
    const result = await run<{
      canonicalFor: unknown[];
      entities: Array<{
        name: string;
        primaryKey: string;
        identities: unknown[];
        relationships: Array<{ with: string }>;
      }>;
      identityResolverFor: unknown[];
    }>(tools.describe_model, { name: "dim_account" });
    expect(result.canonicalFor).toEqual([
      { kind: "entity", name: "account", primaryKey: "account_key" },
    ]);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      name: "account",
      status: "governed",
      primaryKey: "account_key",
    });
    expect(result.entities[0].identities).toHaveLength(3);
    expect(result.entities[0].relationships.map(r => r.with)).toEqual([
      "crm_user",
      "organisation",
      "stripe_customer",
      "close_lead",
      "tag",
    ]);
    expect(result.identityResolverFor).toEqual([
      { entity: "account", system: "crm", column: "organisation_id" },
    ]);
  });

  it("describe_model leaves the entity blocks out on the first schema", async () => {
    await seedProject();
    const result = await run<Record<string, unknown>>(tools.describe_model, {
      name: "fct_account_product_month",
    });
    expect(result.entities).toBeUndefined();
    expect(result.identityResolverFor).toBeUndefined();
  });
});
