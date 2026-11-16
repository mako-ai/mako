import { describe, expect, it } from "vitest";
import { extractTables } from "../../apps/app-search";
import type { SemanticProject } from "../semantic/semantic-manifest.service";
import {
  ONTOLOGY_MANIFEST,
  ONTOLOGY_REGISTRY_YAML,
} from "../test-support/ontology-fixtures";
import {
  LARGE_ENTITY_NAMES,
  LARGE_METRICS,
  LARGE_MODELS,
  LARGE_TERM_NAMES,
} from "../test-support/workspace-context-fixture";
import { buildManifestIndex, type RawManifest } from "./manifest-index";
import type { ProjectManifestIndex } from "./manifest-index.service";
import { emptyRegistry, parseOntologyRegistry } from "./registry";
import {
  renderWorkspaceContext,
  WORKSPACE_CONTEXT_MAX_CHARS,
} from "./workspace-context";

const manifests: ProjectManifestIndex[] = [
  {
    projectId: "p1",
    projectName: "analytics",
    source: "prod",
    index: buildManifestIndex(ONTOLOGY_MANIFEST),
  },
];

const semanticProjects = [
  {
    projectId: "p1",
    projectName: "analytics",
    source: "prod",
    semanticManifestKey: "k",
    environmentName: "prod",
    catalog: {
      metrics: [
        {
          name: "mrr",
          label: "MRR",
          description: "Monthly recurring revenue in EUR, VAT excluded.",
          type: "simple",
        },
        { name: "renewal_rate", type: "ratio" },
      ],
      semanticModels: [],
      savedQueries: [],
      hasTimeSpine: true,
    },
  },
] as unknown as SemanticProject[];

const apps = [
  {
    appId: "a1",
    path: "apps/finance/mrr",
    title: "MRR",
    bindings: [
      {
        binding: "mrr",
        tables: extractTables(
          "select * from {{ dbt_schema }}.fct_account_product_month",
        ),
      },
    ],
  },
  {
    appId: "a2",
    path: "apps/sales/accounts",
    title: "Accounts",
    bindings: [
      {
        binding: "rows",
        tables: extractTables(
          "select * from dbt_prod.dim_account join dbt_prod.fct_account_product_month using (account_id)",
        ),
      },
    ],
  },
];

/** RealAdvisor's size: 117 terms, 39 entities, 117 metrics, 30 read models. */
function largeWorkspace() {
  const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
  const term = registry.terms[0];
  const entity = registry.entities[0];
  // About half governed, as on RealAdvisor.
  registry.terms = LARGE_TERM_NAMES.map((name, i) => ({
    ...term,
    name,
    status: i % 2 === 0 ? "governed" : "draft",
    synonyms: [],
  }));
  registry.entities = LARGE_ENTITY_NAMES.map((name, i) => ({
    ...entity,
    name,
    status: i < 11 ? "governed" : "draft",
    synonyms: [],
  }));
  const semantic = [
    {
      ...semanticProjects[0],
      catalog: {
        ...semanticProjects[0].catalog,
        metrics: LARGE_METRICS.map(([name, type]) => ({
          name,
          type,
          label: name,
          description: "A long description the pack never shows. ".repeat(8),
        })),
      },
    },
  ] as unknown as SemanticProject[];
  const raw: RawManifest = {
    metadata: { project_name: "analytics" },
    nodes: Object.fromEntries(
      LARGE_MODELS.map(([name]) => [
        `model.analytics.${name}`,
        {
          name,
          resource_type: "model",
          original_file_path: `models/marts/${name}.sql`,
          relation_name: `\`acme-prod\`.\`dbt_prod\`.\`${name}\``,
          columns: {},
          depends_on: { nodes: [] },
        },
      ]),
    ),
  } as unknown as RawManifest;
  // App k reads every model with more than k readers.
  const maxReaders = Math.max(...LARGE_MODELS.map(([, readers]) => readers));
  const readerApps = Array.from({ length: maxReaders }, (_, k) => ({
    appId: `app${k}`,
    path: `apps/a${k}`,
    title: `App ${k}`,
    bindings: LARGE_MODELS.filter(([, readers]) => readers > k).map(
      ([name]) => ({
        binding: name,
        tables: extractTables(`select * from {{ dbt_schema }}.${name}`),
      }),
    ),
  }));
  return {
    registry,
    semanticProjects: semantic,
    manifests: [
      {
        projectId: "p1",
        projectName: "analytics",
        source: "prod",
        index: buildManifestIndex(raw),
      },
    ] as ProjectManifestIndex[],
    apps: readerApps,
  };
}

describe("renderWorkspaceContext", () => {
  it("lists governed then draft names, the metrics by type and the most-read models", () => {
    const pack = renderWorkspaceContext({
      registry: parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML),
      semanticProjects,
      manifests,
      apps,
    });
    const { text } = pack;
    expect(text).toContain("Governed terms (1): mrr");
    expect(text).toContain("Draft terms (1): paying_customer");
    expect(text.indexOf("Governed terms")).toBeLessThan(
      text.indexOf("Draft terms"),
    );
    expect(text).toContain("Simple (1): mrr");
    expect(text).toContain("Ratio (1): renewal_rate");
    // No description, not even a short one.
    expect(text).not.toContain("Monthly recurring revenue");
    // fct_account_product_month is read by 2 apps, dim_account by 1.
    expect(text).toContain(
      "Models (2): fct_account_product_month, dim_account",
    );
    expect(pack.counts.metrics).toBe(2);
    expect(pack.counts.leftOut).toBe(0);
  });

  it("lists every name of a RealAdvisor-size workspace in under 6k chars", () => {
    const workspace = largeWorkspace();
    const pack = renderWorkspaceContext(workspace);
    const { text } = pack;
    expect(text.length).toBeLessThan(6_000);
    expect(pack.counts.leftOut).toBe(0);
    expect(text).not.toMatch(/ more: /);
    for (const name of [...LARGE_TERM_NAMES, ...LARGE_ENTITY_NAMES]) {
      expect(text).toMatch(new RegExp(`[:,] ${name}(,|\\n|$)`));
    }
    for (const [name] of LARGE_METRICS) {
      expect(text).toMatch(new RegExp(`[:,] ${name}(,|\\n|$)`));
    }
    expect(text).toContain(
      "Models (30): dim_account, fct_account_product_month,",
    );
    for (const [name] of LARGE_MODELS) {
      expect(text).toMatch(new RegExp(`[:,] ${name}(,|\\n|$)`));
    }
    expect(pack.counts.models).toBe(30);
    expect(text).toContain("Governed entities (11):");
    expect(text).toContain(
      `Draft entities (${LARGE_ENTITY_NAMES.length - 11}):`,
    );
    expect(text.indexOf("Governed entities")).toBeLessThan(
      text.indexOf("Draft entities"),
    );
    expect(text).not.toContain("never shows");
  });

  it("cuts by priority past the budget and says what it left out", () => {
    const workspace = largeWorkspace();
    const pack = renderWorkspaceContext(workspace, { maxChars: 3_000 });
    const { text } = pack;
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(pack.counts.leftOut).toBeGreaterThan(0);
    expect(text).toContain(`${pack.counts.leftOut} names did not fit`);
    // Governed names are kept first: every governed entity is listed.
    expect(text).toContain(
      `Governed entities (11): ${LARGE_ENTITY_NAMES.slice(0, 11)
        .sort((a, b) => a.localeCompare(b))
        .join(", ")}\n`,
    );
    // Draft terms go first: their line names the tool that lists them.
    expect(text).toMatch(/Draft terms \(\d+\): .*more: lookup_term/);
    // The left-out counts add up.
    const cut = [...text.matchAll(/(\d+) more: /g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
    expect(cut).toBe(pack.counts.leftOut);
  });

  it("stays in budget on a huge workspace", () => {
    const workspace = largeWorkspace();
    const many = (names: string[]) =>
      Array.from({ length: 10 }, (_, i) => names.map(n => `${n}_${i}`)).flat();
    workspace.registry.terms = many(LARGE_TERM_NAMES).map(name => ({
      ...workspace.registry.terms[0],
      name,
    }));
    const pack = renderWorkspaceContext(workspace);
    expect(pack.text.length).toBeLessThanOrEqual(WORKSPACE_CONTEXT_MAX_CHARS);
    expect(pack.text).toMatch(/more: lookup_term/);
  });

  it("keeps a group whole when its full line fits but a partial one would not", () => {
    const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
    registry.terms = ["aaaaaaaaaa", "bbbbbbbbbb", "c"].map(name => ({
      ...registry.terms[0],
      name,
      status: "governed",
    }));
    registry.entities = [];
    const input = {
      registry,
      semanticProjects: [],
      manifests: [],
      apps: null,
    };
    const full = renderWorkspaceContext(input, { maxChars: 99_999 }).text;
    // A cut starts (the notice line), yet the one group still fits whole.
    const pack = renderWorkspaceContext(input, { maxChars: full.length });
    expect(pack.text).toContain(
      "Governed terms (3): aaaaaaaaaa, bbbbbbbbbb, c",
    );
    expect(pack.counts.leftOut).toBe(0);
  });

  it("never splits a name holding a comma or a newline", () => {
    const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
    registry.terms = [
      { ...registry.terms[0], name: "Revenue, net of refunds" },
      { ...registry.terms[0], name: "net\n## revenue" },
    ];
    const { text } = renderWorkspaceContext({
      registry,
      semanticProjects,
      manifests,
      apps,
    });
    expect(text).toContain(
      'Governed terms (2): net ## revenue, "Revenue, net of refunds"',
    );
    expect(text).not.toMatch(/^## revenue/m);
  });

  it("reads an entry without a status as a draft", () => {
    // The fixture's `account` entity has no status.
    const { text } = renderWorkspaceContext({
      registry: parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML),
      semanticProjects,
      manifests,
      apps,
    });
    expect(text).toContain("Draft entities (1): account");
  });

  it("says a failed load could not be read, not that nothing is defined", () => {
    const { text } = renderWorkspaceContext({
      registry: parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML),
      semanticProjects: null,
      manifests: null,
      apps,
    });
    expect(text).toContain("could not be read right now: use list_metrics");
    expect(text).toContain("could not be read right now: use find_models");
    expect(text).not.toContain("No metric is defined yet.");
  });

  it("says what is missing instead of failing", () => {
    const { text } = renderWorkspaceContext({
      registry: emptyRegistry("absent"),
      semanticProjects: [],
      manifests: [],
      apps: null,
    });
    expect(text).toContain("No metric is defined yet.");
    expect(text).toContain("No dbt manifest is stored yet.");
  });
});
