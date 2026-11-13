import { describe, expect, it } from "vitest";
import {
  matchRegistry,
  parseOntologyRegistry,
  parseRawRelationships,
  walkRelationships,
  phraseSimilarity,
  registryRolesByModel,
  registryStatusMessage,
  scoreRegistry,
} from "./registry";
import {
  ONTOLOGY_GRAPH_YAML,
  ONTOLOGY_PATHS_YAML,
  ONTOLOGY_RAW_RELATIONSHIPS_YAML,
  ONTOLOGY_REGISTRY_YAML,
} from "../test-support/ontology-fixtures";

describe("parseOntologyRegistry", () => {
  it("reads terms and entities in the workspace schema", () => {
    const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
    expect(registry.status).toBe("ok");
    expect(registry.version).toBe(1);
    expect(registry.problems).toEqual([]);
    expect(registry.terms.map(t => t.name)).toEqual(["mrr", "paying_customer"]);
    expect(registry.terms[0]).toMatchObject({
      kind: "term",
      label: "MRR",
      owner: "finance",
      status: "governed",
      canonical: { model: "fct_account_product_month", column: "mrr_eur" },
      grain: "account x product x month",
      synonyms: ["monthly recurring revenue"],
      knownVariants: [
        {
          model: "int_fr_renewals__contract_periods",
          difference: "Contract MRR, VAT included, France only.",
        },
      ],
    });
    expect(registry.terms[0].definition).toContain("Monthly recurring revenue");
    expect(registry.terms[0].forbiddenPatterns).toEqual([
      {
        regex: "sum\\(.*amount.*\\)\\s*/\\s*12",
        message: "Read mrr_eur from fct_account_product_month.",
        paths: ["dbt/models/**", "apps/**/bindings/**"],
      },
    ]);
    expect(registry.entities).toEqual([
      {
        kind: "entity",
        name: "account",
        label: "Account",
        definition: "A customer organisation.",
        owner: "sales-ops",
        canonical: { model: "dim_account", primaryKey: "account_id" },
        sources: ["crm_public.organisations"],
        identities: [],
        synonyms: ["organisation", "customer organisation"],
        knownVariants: [],
      },
    ]);
    // The first schema declared no relationships: none, and no problem.
    expect(registry.relationships).toEqual([]);
    expect(registry.rawRelationships).toEqual([]);
  });

  it("treats a missing file as an absent, empty registry", () => {
    for (const input of [null, undefined]) {
      const registry = parseOntologyRegistry(input);
      expect(registry).toEqual({
        status: "absent",
        terms: [],
        entities: [],
        relationships: [],
        paths: [],
        rawRelationships: [],
        problems: [],
      });
      expect(registryStatusMessage(registry)).toContain("no ontology registry");
    }
  });

  it("treats invalid YAML as malformed and empty, never throwing", () => {
    const registry = parseOntologyRegistry("terms:\n  - name: mrr\n   bad: [");
    expect(registry.status).toBe("malformed");
    expect(registry.terms).toEqual([]);
    expect(registry.entities).toEqual([]);
    expect(registry.problems).toHaveLength(1);
    expect(registryStatusMessage(registry)).toContain("could not be parsed");
  });

  it("treats a file whose top level is not a mapping as malformed", () => {
    expect(parseOntologyRegistry("- just\n- a list\n").status).toBe(
      "malformed",
    );
    expect(parseOntologyRegistry("a string").status).toBe("malformed");
  });

  it("reads an empty file as an empty registry", () => {
    const registry = parseOntologyRegistry("");
    expect(registry.status).toBe("ok");
    expect(registry.terms).toEqual([]);
    expect(parseOntologyRegistry("# only a comment\n").status).toBe("ok");
  });

  it("skips entries without a name, repeats and wrong shapes, and says so", () => {
    const registry = parseOntologyRegistry(`
terms:
  - label: No name
  - name: mrr
  - name: MRR
  - just a string
  - name: churn
    canonical: fct_churn
    synonyms: logo churn
    known_variants: [{difference: no model}, {model: int_churn}]
    forbidden_patterns: [{message: no regex}]
entities: not-a-list
`);
    expect(registry.status).toBe("ok");
    expect(registry.terms.map(t => t.name)).toEqual(["mrr", "churn"]);
    expect(registry.terms[1]).toMatchObject({
      canonical: undefined,
      synonyms: ["logo churn"],
      knownVariants: [{ model: "int_churn" }],
      forbiddenPatterns: [],
    });
    expect(registry.entities).toEqual([]);
    expect(registry.problems).toEqual([
      "terms[0] has no `name`; it was skipped.",
      "terms[2] repeats `MRR`; the first one wins.",
      "terms[3] has no `name`; it was skipped.",
      "`entities` must be a list; it was ignored.",
    ]);
  });
});

describe("registry lookup", () => {
  const registry = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
  const best = (query: string) => matchRegistry(registry, query)[0];

  it("resolves a name, a label and a synonym, whatever the case", () => {
    expect(best("mrr")).toMatchObject({ matchedOn: "name", score: 1 });
    expect(best("MRR").entry.name).toBe("mrr");
    expect(best("Monthly Recurring Revenue")).toMatchObject({
      matchedOn: "synonym",
      score: 1,
    });
    expect(best("Account").entry).toMatchObject({
      kind: "entity",
      name: "account",
    });
  });

  it("is fuzzy enough for plurals, extra words and typos", () => {
    expect(best("paying customers").entry.name).toBe("paying_customer");
    expect(best("paying customer").entry.name).toBe("paying_customer");
    expect(best("what is our MRR").entry.name).toBe("mrr");
    expect(best("montly recuring revenue").entry.name).toBe("mrr");
    expect(best("organisations").entry.name).toBe("account");
  });

  it("matches nothing for an unrelated phrase, and still ranks the closest", () => {
    expect(matchRegistry(registry, "listing price per square metre")).toEqual(
      [],
    );
    expect(matchRegistry(registry, "")).toEqual([]);
    const closest = scoreRegistry(registry, "recurring revenue");
    expect(closest[0].entry.name).toBe("mrr");
  });

  it("scores phrases on words, not substrings", () => {
    expect(phraseSimilarity("mrr", "MRR")).toBe(1);
    expect(phraseSimilarity("paying customers", "paying customer")).toBe(0.95);
    expect(phraseSimilarity("customers paying", "paying customer")).toBe(0.9);
    expect(phraseSimilarity("our mrr today", "mrr")).toBe(0.8);
    expect(phraseSimilarity("term", "terminal velocity")).toBeLessThan(0.7);
  });

  it("maps models to the terms they are canonical for or a variant of", () => {
    const roles = registryRolesByModel(registry);
    expect(roles.get("fct_account_product_month")?.canonicalFor).toEqual([
      { kind: "term", name: "mrr", column: "mrr_eur" },
    ]);
    expect(roles.get("dim_account")?.canonicalFor).toEqual([
      { kind: "term", name: "paying_customer", column: "is_paying" },
      { kind: "entity", name: "account", primaryKey: "account_id" },
    ]);
    expect(roles.get("int_fr_renewals__contract_periods")?.variantOf).toEqual([
      {
        term: "mrr",
        canonicalModel: "fct_account_product_month",
        canonicalColumn: "mrr_eur",
        difference: "Contract MRR, VAT included, France only.",
      },
    ]);
  });
});

describe("entities and relationships", () => {
  const registry = parseOntologyRegistry(
    ONTOLOGY_GRAPH_YAML,
    ONTOLOGY_RAW_RELATIONSHIPS_YAML,
  );

  it("reads the entity fields of the graph schema", () => {
    expect(registry.status).toBe("ok");
    expect(registry.entities).toHaveLength(10);
    expect(registry.entities[0]).toEqual({
      kind: "entity",
      name: "account",
      label: "Account",
      definition:
        "A CRM organisation that links to at least one Stripe customer.",
      owner: "data",
      status: "governed",
      canonical: { model: "dim_account", primaryKey: "account_key" },
      grain: "one row per CRM organisation with at least one Stripe customer",
      sources: ["crm_public.organisations", "int_crm__customer_account"],
      identities: [
        { system: "crm", column: "organisation_id", resolver: "dim_account" },
        {
          system: "stripe",
          column: "customer_id",
          resolver: "int_crm__customer_account",
        },
        { system: "close", column: "close_lead_id" },
      ],
      synonyms: ["customer account", "customer", "client"],
      knownVariants: [
        {
          model: "int_fr_renewals__identity",
          difference: "FR only. Maps a Stripe customer to a Close lead.",
        },
      ],
    });
    const demo = registry.entities.find(e => e.name === "demo");
    expect(demo?.canonical?.primaryKey).toEqual(["country", "demo_key"]);
    expect(demo?.openPoint).toBe("The demo key is per country.");
  });

  it("reads relationships with their columns, status and source", () => {
    expect(registry.relationships).toHaveLength(12);
    expect(registry.relationships[0]).toEqual({
      name: "account_is_organisation",
      from: "account",
      to: "organisation",
      cardinality: "one_to_one",
      join: [{ fromColumn: "organisation_id", toColumn: "organisation_id" }],
      status: "governed",
      source: "declared",
      evidence: "0 orphans in 10,315 rows.",
    });
    const demo = registry.relationships.find(
      r => r.name === "demo_belongs_to_close_lead",
    );
    expect(demo?.join).toEqual([
      { fromColumn: "lead_id", toColumn: "lead_id" },
      { fromColumn: "country", toColumn: "country" },
    ]);
    expect(
      registry.relationships.find(
        r => r.name === "crm_team_billed_to_organisation",
      )?.openPoint,
    ).toBe("The column is null on two-thirds of teams.");
  });

  it("lists an entity's known variants among a model's roles", () => {
    expect(
      registryRolesByModel(registry).get("int_fr_renewals__identity")
        ?.variantOf,
    ).toEqual([
      {
        kind: "entity",
        term: "account",
        canonicalModel: "dim_account",
        difference: "FR only. Maps a Stripe customer to a Close lead.",
      },
    ]);
  });

  it("skips malformed relationships and says which", () => {
    const broken = parseOntologyRegistry(`
entities:
  - name: a
    canonical: {model: m_a, primary_key: id}
  - name: b
    canonical: {model: m_b, primary_key: id}
relationships:
  - name: ok
    from: a
    to: b
    cardinality: Many-To-One
    join: [{from_column: b_id, to_column: id}]
  - from: a
    to: b
  - name: no_ends
    cardinality: many_to_one
    join: [{from_column: x, to_column: y}]
  - name: bad_cardinality
    from: a
    to: b
    cardinality: sometimes
    join: [{from_column: x, to_column: y}]
  - name: no_join
    from: a
    to: b
    cardinality: many_to_one
    join: [{from_column: x}]
  - name: unknown_entity
    from: a
    to: zebra
    cardinality: many_to_one
    join: [{from_column: x, to_column: y}]
  - name: ok
    from: b
    to: a
    cardinality: one_to_one
    join: [{from_column: id, to_column: id}]
  - just a string
`);
    expect(broken.status).toBe("ok");
    expect(broken.relationships).toEqual([
      {
        name: "ok",
        from: "a",
        to: "b",
        cardinality: "many_to_one",
        join: [{ fromColumn: "b_id", toColumn: "id" }],
      },
    ]);
    expect(broken.problems).toEqual([
      "relationships[1] has no `name`; it was skipped.",
      "relationship `no_ends` needs `from` and `to`; it was skipped.",
      "relationship `bad_cardinality` has an unknown cardinality `sometimes`; it was skipped.",
      "relationship `no_join` has no `join` column pair; it was skipped.",
      "relationship `unknown_entity` names an unknown entity `zebra`; it was skipped.",
      "relationships[6] repeats `ok`; the first one wins.",
      "relationships[7] has no `name`; it was skipped.",
    ]);
  });

  it("ignores a `relationships` key that is not a list", () => {
    const odd = parseOntologyRegistry("relationships: {a: b}\n");
    expect(odd.relationships).toEqual([]);
    expect(odd.problems).toEqual([
      "`relationships` must be a list; it was ignored.",
    ]);
  });
});

describe("parseRawRelationships", () => {
  it("reads the generated mapping: bare tables, hasura_name, one_to_many", () => {
    const { relationships, problems } = parseRawRelationships(
      ONTOLOGY_RAW_RELATIONSHIPS_YAML,
    );
    expect(relationships).toHaveLength(6);
    expect(relationships[0]).toEqual({
      name: "default_team",
      fromTable: "crm_public.users",
      fromColumns: ["default_team_id"],
      toTable: "crm_public.teams",
      toColumns: ["id"],
      cardinality: "many_to_one",
      kind: "fk",
      inWarehouse: true,
    });
    expect(relationships[1].cardinality).toBe("one_to_many");
    expect(relationships[4]).toMatchObject({
      name: "activities_participants",
      kind: "manual",
      inWarehouse: false,
      inferred: true,
    });
    expect(relationships[5]).toMatchObject({
      fromColumns: ["tenant_id", "property_id"],
      toColumns: ["tenant_id", "id"],
    });
    // 2 from-columns against 1 to-column: not a usable key.
    expect(problems).toEqual([
      "dbt/ontology/generated/crm_relationships.yml: 1 of 7 records were skipped (tables, cardinality or columns missing).",
    ]);
  });

  it("reads a bare list, `name`, and qualified tables", () => {
    const { relationships, problems } = parseRawRelationships(`
- from_table: stripe.Invoices
  from_columns: customer
  to_table: "stripe.customers"
  to_columns: [id]
  cardinality: many_to_one
  name: customer
  kind: fk
`);
    expect(problems).toEqual([]);
    expect(relationships).toEqual([
      {
        name: "customer",
        fromTable: "stripe.invoices",
        fromColumns: ["customer"],
        toTable: "stripe.customers",
        toColumns: ["id"],
        cardinality: "many_to_one",
        kind: "fk",
      },
    ]);
  });

  it("is empty for an absent, empty, malformed or misshapen file", () => {
    expect(parseRawRelationships(null)).toEqual({
      relationships: [],
      problems: [],
    });
    expect(parseRawRelationships("# nothing\n")).toEqual({
      relationships: [],
      problems: [],
    });
    expect(parseRawRelationships("relationships: [")).toMatchObject({
      relationships: [],
      problems: [expect.stringContaining("could not be parsed")],
    });
    expect(parseRawRelationships("counts: {tables: 1}\n")).toMatchObject({
      relationships: [],
      problems: [expect.stringContaining("must be a list")],
    });
    expect(
      parseRawRelationships("- 1\n- {from_table: a}\n").relationships,
    ).toEqual([]);
  });

  it("keeps the registry when the generated file is broken", () => {
    const registry = parseOntologyRegistry(
      ONTOLOGY_GRAPH_YAML,
      "relationships: [",
    );
    expect(registry.status).toBe("ok");
    expect(registry.relationships).toHaveLength(12);
    expect(registry.rawRelationships).toEqual([]);
    expect(registry.problems).toEqual([
      expect.stringContaining("could not be parsed"),
    ]);
  });
});

describe("role links and curated paths", () => {
  const registry = parseOntologyRegistry(ONTOLOGY_PATHS_YAML);

  it("reads `traversal: explicit` and leaves the others default", () => {
    expect(registry.problems).toEqual([]);
    const flagged = registry.relationships.filter(r => r.explicit);
    expect(flagged.map(r => r.name)).toEqual(["account_closed_by_crm_user"]);
    expect(
      registry.relationships.find(r => r.name === "account_is_organisation"),
    ).not.toHaveProperty("explicit");
    // The first two schemas carry neither field.
    const graph = parseOntologyRegistry(ONTOLOGY_GRAPH_YAML);
    expect(graph.paths).toEqual([]);
    expect(graph.relationships.some(r => r.explicit)).toBe(false);
  });

  it("reads `traversal: default`, and an unknown value as default with a problem", () => {
    const odd = parseOntologyRegistry(`
entities:
  - {name: a, canonical: {model: m_a}}
  - {name: b, canonical: {model: m_b}}
relationships:
  - {name: r1, from: a, to: b, cardinality: many_to_one, traversal: default, join: [{from_column: b_id, to_column: id}]}
  - {name: r2, from: a, to: b, cardinality: many_to_one, traversal: EXPLICIT, join: [{from_column: b2_id, to_column: id}]}
  - {name: r3, from: a, to: b, cardinality: many_to_one, traversal: sometimes, join: [{from_column: b3_id, to_column: id}]}
`);
    expect(odd.relationships.map(r => r.explicit ?? false)).toEqual([
      false,
      true,
      false,
    ]);
    expect(odd.problems).toEqual([
      "relationship `r3` has an unknown traversal `sometimes`; it is read as `default`.",
    ]);
  });

  it("reads a curated path with its ordered steps and caveats", () => {
    expect(registry.paths).toEqual([
      {
        name: "enquiry_to_account",
        from: "enquiry",
        to: "account",
        status: "draft",
        description:
          "The account an enquiry belongs to: the organisation of its tenant, else the organisation of the team of the listing's broker.",
        steps: [
          {
            name: "linked_tenant",
            via: [
              "enquiry_in_linked_tenant_of_organisation",
              "account_is_organisation",
            ],
            note: "Covers enquiries of a white-label tenant.",
          },
          {
            name: "listing_broker",
            via: [
              "enquiry_about_listing",
              "listing_managed_by_crm_user",
              "crm_user_has_primary_crm_team",
              "crm_team_belongs_to_organisation",
              "account_is_organisation",
            ],
          },
        ],
        caveats: ["team_id is filled on 2.4% of enquiries"],
      },
    ]);
  });

  it("walks relationship names end to end, in either direction of each", () => {
    const walk = walkRelationships(registry.relationships, "enquiry", [
      "enquiry_in_linked_tenant_of_organisation",
      "account_is_organisation",
    ]);
    expect("problem" in walk).toBe(false);
    if ("problem" in walk) return;
    expect(walk.end).toBe("account");
    expect(walk.hops.map(hop => hop.forward)).toEqual([true, false]);
  });

  it("drops a step that names nothing, does not chain or ends elsewhere, and says why", () => {
    const base = ONTOLOGY_PATHS_YAML.slice(
      0,
      ONTOLOGY_PATHS_YAML.indexOf("paths:"),
    );
    const broken = parseOntologyRegistry(`${base}paths:
  - name: mixed
    from: enquiry
    to: account
    steps:
      - name: good
        via: [enquiry_in_linked_tenant_of_organisation, account_is_organisation]
      - name: unknown_name
        via: [enquiry_in_linked_tenant_of_organisation, nope]
      - name: gap
        via: [enquiry_about_listing, crm_team_belongs_to_organisation]
      - name: stops_short
        via: [enquiry_about_listing, listing_managed_by_crm_user]
      - name: empty
        via: []
      - just a string
  - name: nothing_usable
    from: enquiry
    to: account
    steps:
      - via: [nope]
  - name: no_ends
    steps:
      - via: [account_is_organisation]
  - name: unknown_entity
    from: enquiry
    to: zebra
    steps:
      - via: [enquiry_about_listing]
  - name: no_steps
    from: enquiry
    to: account
  - from: enquiry
    to: account
`);
    expect(broken.status).toBe("ok");
    expect(broken.paths.map(path => path.name)).toEqual(["mixed"]);
    expect(broken.paths[0].steps.map(step => step.name)).toEqual(["good"]);
    expect(broken.problems).toEqual([
      "path `mixed` step `unknown_name` names an unknown relationship `nope`; it was skipped.",
      "path `mixed` step `gap` does not chain: `crm_team_belongs_to_organisation` joins `crm_team` and `organisation`, not `listing`; it was skipped.",
      "path `mixed` step `stops_short` ends at `crm_user`, not at `account`; it was skipped.",
      "path `mixed` step `empty` has no `via` relationships; it was skipped.",
      "path `mixed` step 6 has no `via` relationships; it was skipped.",
      "path `nothing_usable` step 1 names an unknown relationship `nope`; it was skipped.",
      "path `nothing_usable` has no usable step; it was skipped.",
      "path `no_ends` needs `from` and `to`; it was skipped.",
      "path `unknown_entity` names an unknown entity `zebra`; it was skipped.",
      "path `no_steps` has no usable step; it was skipped.",
      "paths[5] has no `name`; it was skipped.",
    ]);
  });

  it("ignores a `paths` key that is not a list", () => {
    const odd = parseOntologyRegistry("paths: nope\n");
    expect(odd.paths).toEqual([]);
    expect(odd.problems).toEqual(["`paths` must be a list; it was ignored."]);
  });
});
