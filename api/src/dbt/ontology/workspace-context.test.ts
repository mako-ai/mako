import { describe, expect, it } from "vitest";
import { extractTables } from "../../apps/app-search";
import type { SemanticProject } from "../semantic/semantic-manifest.service";
import {
  ONTOLOGY_MANIFEST,
  ONTOLOGY_REGISTRY_YAML,
} from "../test-support/ontology-fixtures";
import { buildManifestIndex } from "./manifest-index";
import type { ProjectManifestIndex } from "./manifest-index.service";
import { emptyRegistry, parseOntologyRegistry } from "./registry";
import { renderWorkspaceContext } from "./workspace-context";

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

describe("renderWorkspaceContext", () => {
  it("lists governed then draft terms, the metrics and the most-read models", () => {
    const pack = renderWorkspaceContext({
      registry: parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML),
      semanticProjects,
      manifests,
      apps,
    });
    const { text } = pack;
    expect(text).toContain(
      "- mrr [governed] → fct_account_product_month.mrr_eur · metric mrr",
    );
    expect(text).toContain("- paying_customer [draft] → dim_account.is_paying");
    expect(text.indexOf("- mrr [governed]")).toBeLessThan(
      text.indexOf("- paying_customer [draft]"),
    );
    expect(text).toContain(
      "- mrr (simple): Monthly recurring revenue in EUR, VAT excluded.",
    );
    expect(text).toContain("- renewal_rate (ratio)");
    // fct_account_product_month is read by 2 apps, dim_account by 1.
    expect(text.indexOf("- fct_account_product_month (2")).toBeGreaterThan(-1);
    expect(text.indexOf("- fct_account_product_month (2")).toBeLessThan(
      text.indexOf("- dim_account (1"),
    );
    expect(pack.counts.metrics).toBe(2);
    expect(text.length).toBeLessThan(4_500);
  });

  it("stays near 4k chars on a large workspace and says how to find the rest", () => {
    const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
    registry.terms = Array.from({ length: 300 }, (_, i) => ({
      ...registry.terms[0],
      name: `term_${i}`,
      synonyms: [],
    }));
    const many = [
      {
        ...semanticProjects[0],
        catalog: {
          ...semanticProjects[0].catalog,
          metrics: Array.from({ length: 200 }, (_, i) => ({
            name: `metric_${i}`,
            type: "simple" as const,
            description: "x ".repeat(80),
          })),
        },
      },
    ] as unknown as SemanticProject[];
    const { text } = renderWorkspaceContext({
      registry,
      semanticProjects: many,
      manifests,
      apps,
    });
    expect(text.length).toBeLessThan(4_500);
    expect(text).toMatch(/more: lookup_term/);
    expect(text).toMatch(/more: list_metrics/);
  });

  it("reads an entry without a status as a draft", () => {
    // The fixture's `account` entity has no status.
    const { text } = renderWorkspaceContext({
      registry: parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML),
      semanticProjects,
      manifests,
      apps,
    });
    expect(text).toContain(
      "- account [draft, entity] → dim_account (account_id)",
    );
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
