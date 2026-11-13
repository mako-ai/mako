import { describe, expect, it } from "vitest";
import {
  matchRegistry,
  parseOntologyRegistry,
  phraseSimilarity,
  registryRolesByModel,
  registryStatusMessage,
  scoreRegistry,
} from "./registry";
import { ONTOLOGY_REGISTRY_YAML } from "../test-support/ontology-fixtures";

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
        synonyms: ["organisation", "customer organisation"],
      },
    ]);
  });

  it("treats a missing file as an absent, empty registry", () => {
    for (const input of [null, undefined]) {
      const registry = parseOntologyRegistry(input);
      expect(registry).toEqual({
        status: "absent",
        terms: [],
        entities: [],
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
