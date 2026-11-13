import { describe, expect, it } from "vitest";
import {
  closestEntities,
  findJoinPath,
  relationshipsOfEntity,
  resolveJoinEndpoint,
  type JoinPathResult,
} from "./join-path";
import { emptyRegistry, parseOntologyRegistry } from "./registry";
import {
  ONTOLOGY_GRAPH_YAML,
  ONTOLOGY_RAW_RELATIONSHIPS_YAML,
  ONTOLOGY_REGISTRY_YAML,
} from "../test-support/ontology-fixtures";

const registry = parseOntologyRegistry(
  ONTOLOGY_GRAPH_YAML,
  ONTOLOGY_RAW_RELATIONSHIPS_YAML,
);

/** `a -(relationship)-> b -(…)-> c`, one line per path. */
const trail = (result: JoinPathResult) =>
  result.paths.map(path =>
    path.steps
      .map(
        (step, i) =>
          `${i === 0 ? (step.from.entity ?? step.from.model) : ""} -(${step.relationship})-> ${step.to.entity ?? step.to.model}`,
      )
      .join(""),
  );

describe("resolveJoinEndpoint", () => {
  const kind = (
    text: string,
    modelNameOf?: (t: string) => string | undefined,
  ) => {
    const end = resolveJoinEndpoint(registry, text, modelNameOf);
    return end.kind === "entity"
      ? `entity:${end.entity.name}:${end.matchedOn}`
      : end.kind === "table"
        ? `table:${end.table}`
        : "unknown";
  };

  it("names an entity by name, canonical model, label or synonym", () => {
    expect(kind("subscription")).toBe("entity:subscription:name");
    expect(kind("Stripe Customer")).toBe("entity:stripe_customer:name");
    expect(kind("dim_account")).toBe("entity:account:model");
    expect(kind("DIM_ACCOUNT")).toBe("entity:account:model");
    expect(kind("Team (agency)")).toBe("entity:crm_team:label");
    expect(kind("customers")).toBe("entity:account:synonym");
    expect(kind("agency")).toBe("entity:crm_team:synonym");
  });

  it("maps a warehouse relation to its model through the manifest", () => {
    const modelNameOf = (text: string) =>
      text === "dbt_prod.dim_account" ? "dim_account" : undefined;
    expect(kind("dbt_prod.dim_account", modelNameOf)).toBe(
      "entity:account:model",
    );
    expect(kind("dbt_prod.dim_account")).toBe("unknown");
  });

  it("names a raw table, bare or qualified, and never as a phrase", () => {
    expect(kind("crm_public.users")).toBe("table:crm_public.users");
    expect(kind("`crm_public`.`Teams`")).toBe("table:crm_public.teams");
    expect(kind("activities")).toBe("table:crm_public.activities");
    // `users` alone is the synonym of an entity before it is a table.
    expect(kind("users")).toBe("entity:crm_user:synonym");
    expect(kind("crm_public.nope")).toBe("unknown");
  });

  it("returns the closest entity names for something unknown", () => {
    const end = resolveJoinEndpoint(registry, "subscriptons plan");
    expect(end.kind).toBe("unknown");
    expect(closestEntities(registry, "subscriptons plan")[0]).toBe(
      "subscription",
    );
    expect(closestEntities(registry, "zzz")).toHaveLength(5);
  });
});

describe("findJoinPath: entities", () => {
  it("returns a direct relationship as one hop", () => {
    const result = findJoinPath(registry, "subscription", "stripe_customer");
    expect(result).toEqual({
      from: {
        input: "subscription",
        kind: "entity",
        entity: "subscription",
        model: "stg_stripe__subscriptions",
        primaryKey: "subscription_id",
        status: "governed",
        matchedOn: "name",
      },
      to: {
        input: "stripe_customer",
        kind: "entity",
        entity: "stripe_customer",
        model: "int_crm__customer_account",
        primaryKey: "customer_id",
        status: "governed",
        matchedOn: "name",
      },
      level: "entity",
      paths: [
        {
          hops: 1,
          governed: true,
          fanOut: false,
          steps: [
            {
              relationship: "subscription_belongs_to_stripe_customer",
              from: {
                entity: "subscription",
                model: "stg_stripe__subscriptions",
              },
              to: {
                entity: "stripe_customer",
                model: "int_crm__customer_account",
              },
              join: [{ fromColumn: "customer_id", toColumn: "customer_id" }],
              on: "stg_stripe__subscriptions.customer_id = int_crm__customer_account.customer_id",
              cardinality: "many_to_one",
              status: "governed",
              source: "hasura_fk",
            },
          ],
        },
      ],
    });
  });

  it("walks two hops, with no fan-out up the foreign keys", () => {
    const result = findJoinPath(registry, "subscription", "customer");
    expect(result.to).toMatchObject({
      entity: "account",
      matchedOn: "synonym",
    });
    expect(trail(result)).toEqual([
      "subscription -(subscription_belongs_to_stripe_customer)-> stripe_customer -(stripe_customer_belongs_to_account)-> account",
    ]);
    expect(result.paths[0]).toMatchObject({
      hops: 2,
      governed: true,
      fanOut: false,
    });
  });

  it("turns the hops around and warns about the fan-out", () => {
    const result = findJoinPath(registry, "dim_account", "subscription");
    const [first, second] = result.paths[0].steps;
    expect(result.paths[0].fanOut).toBe(true);
    expect(first).toMatchObject({
      relationship: "stripe_customer_belongs_to_account",
      from: { entity: "account", model: "dim_account" },
      to: { entity: "stripe_customer", model: "int_crm__customer_account" },
      cardinality: "one_to_many",
      on: "dim_account.account_key = int_crm__customer_account.account_key",
      fanOut:
        "One account row matches many stripe_customer rows. Measures of account repeat after this join: aggregate stripe_customer to the account grain first, or count distinct.",
    });
    expect(second.cardinality).toBe("one_to_many");
    expect(second.join).toEqual([
      { fromColumn: "customer_id", toColumn: "customer_id" },
    ]);
  });

  it("warns on many_to_many in both directions, never on one_to_one", () => {
    for (const [from, to] of [
      ["account", "tag"],
      ["tag", "account"],
    ]) {
      const [step] = findJoinPath(registry, from, to).paths[0].steps;
      expect(step.cardinality).toBe("many_to_many");
      expect(step.fanOut).toContain("Both sides repeat");
    }
    const [oneToOne] = findJoinPath(registry, "organisation", "account")
      .paths[0].steps;
    expect(oneToOne.cardinality).toBe("one_to_one");
    expect(oneToOne.fanOut).toBeUndefined();
    expect(oneToOne.on).toBe(
      "stg_crm__organisations.organisation_id = dim_account.organisation_id",
    );
  });

  it("takes the direct relationship over a longer way round", () => {
    // stripe_customer - account - organisation exists too, at 2 hops.
    expect(
      trail(findJoinPath(registry, "stripe_customer", "organisation")),
    ).toEqual([
      "stripe_customer -(stripe_customer_belongs_to_organisation)-> organisation",
    ]);
  });

  it("prefers the governed relationship between one pair, and lists the other", () => {
    const [step] = findJoinPath(registry, "crm_team", "organisation").paths[0]
      .steps;
    expect(step).toMatchObject({
      relationship: "crm_team_belongs_to_organisation",
      status: "governed",
      alternatives: [
        {
          relationship: "crm_team_billed_to_organisation",
          join: [
            {
              fromColumn: "billing_organisation_id",
              toColumn: "organisation_id",
            },
          ],
          status: "draft",
        },
      ],
    });
  });

  it("orders equally short paths: governed first, and says how many", () => {
    // Round the cycle account - organisation - team - user - account.
    const result = findJoinPath(registry, "crm_team", "account");
    expect(trail(result)).toEqual([
      "crm_team -(crm_team_belongs_to_organisation)-> organisation -(account_is_organisation)-> account",
      "crm_team -(crm_user_has_primary_crm_team)-> crm_user -(account_closed_by_crm_user)-> account",
    ]);
    expect(result.paths.map(path => path.governed)).toEqual([true, false]);
    expect(result.pathsTotal).toBeUndefined();
  });

  it("uses a draft relationship when it is the only way, and says so", () => {
    const result = findJoinPath(registry, "demo", "account");
    expect(trail(result)).toEqual([
      "demo -(demo_belongs_to_close_lead)-> close_lead -(account_has_close_lead)-> account",
    ]);
    expect(result.paths[0].governed).toBe(false);
    const [first, second] = result.paths[0].steps;
    expect(first.status).toBe("draft");
    // A composite key: both column pairs, in the join condition too.
    expect(first.on).toBe(
      "fct_intl_sales_demos.lead_id = int_close__leads.lead_id and fct_intl_sales_demos.country = int_close__leads.country",
    );
    expect(second).toMatchObject({
      cardinality: "one_to_many",
      join: [{ fromColumn: "lead_id", toColumn: "close_lead_id" }],
    });
  });

  it("lists an all-governed path one hop longer after a shorter draft one", () => {
    const small = parseOntologyRegistry(`
entities:
  - {name: a, canonical: {model: m_a, primary_key: id}}
  - {name: b, canonical: {model: m_b, primary_key: id}}
  - {name: c, canonical: {model: m_c, primary_key: id}}
  - {name: d, canonical: {model: m_d, primary_key: id}}
relationships:
  - {name: a_b_draft, from: a, to: b, cardinality: many_to_one, status: draft, join: [{from_column: b_guess, to_column: id}]}
  - {name: a_c, from: a, to: c, cardinality: many_to_one, status: governed, join: [{from_column: c_id, to_column: id}]}
  - {name: c_b, from: c, to: b, cardinality: many_to_one, status: governed, join: [{from_column: b_id, to_column: id}]}
  - {name: a_d_draft, from: a, to: d, cardinality: many_to_one, status: draft, join: [{from_column: d_guess, to_column: id}]}
  - {name: b_d, from: b, to: d, cardinality: many_to_one, status: governed, join: [{from_column: d_id, to_column: id}]}
`);
    expect(trail(findJoinPath(small, "a", "b"))).toEqual([
      "a -(a_b_draft)-> b",
      "a -(a_c)-> c -(c_b)-> b",
    ]);
    // The governed way to d is 3 hops, 2 longer than the draft: left out.
    expect(trail(findJoinPath(small, "a", "d"))).toEqual([
      "a -(a_d_draft)-> d",
    ]);
  });

  it("keeps the 3 best of many equally short paths and counts them all", () => {
    const hubs = ["h1", "h2", "h3", "h4", "h5"];
    const many = parseOntologyRegistry(`
entities:
${["a", "z", ...hubs].map(n => `  - {name: ${n}, canonical: {model: m_${n}, primary_key: id}}`).join("\n")}
relationships:
${hubs
  .flatMap(h => [
    `  - {name: a_${h}, from: a, to: ${h}, cardinality: many_to_one, status: ${h === "h4" ? "governed" : "draft"}, join: [{from_column: ${h}_id, to_column: id}]}`,
    `  - {name: ${h}_z, from: ${h}, to: z, cardinality: many_to_one, status: ${h === "h4" ? "governed" : "draft"}, join: [{from_column: z_id, to_column: id}]}`,
  ])
  .join("\n")}
`);
    const result = findJoinPath(many, "a", "z");
    expect(result.paths).toHaveLength(3);
    expect(result.pathsTotal).toBe(5);
    expect(trail(result)[0]).toBe("a -(a_h4)-> h4 -(h4_z)-> z");
  });

  it("walks a relationship of an entity with itself", () => {
    const result = findJoinPath(registry, "organisation", "org");
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].steps[0]).toMatchObject({
      relationship: "organisation_has_parent_organisation",
      cardinality: "many_to_one",
      on: "stg_crm__organisations.parent_organisation_id = stg_crm__organisations.organisation_id",
    });
    // An entity with no self relationship joins to nothing new.
    const none = findJoinPath(registry, "account", "account");
    expect(none.paths).toEqual([]);
    expect(none.level).toBe("none");
  });

  it("stops at maxHops and says how far the path is", () => {
    const short = findJoinPath(registry, "demo", "subscription", {
      maxHops: 2,
    });
    expect(short.paths).toEqual([]);
    expect(short.message).toBe(
      "No declared path within 2 hops. A path of 4 hops exists: pass maxHops: 4.",
    );
    const full = findJoinPath(registry, "demo", "subscription");
    expect(full.paths[0].hops).toBe(4);
    // Out-of-range limits are clamped, never an error.
    expect(
      findJoinPath(registry, "demo", "subscription", { maxHops: 99 }).paths[0]
        .hops,
    ).toBe(4);
    expect(
      findJoinPath(registry, "demo", "subscription", { maxHops: 0 }).paths,
    ).toEqual([]);
  });

  it("says when nothing connects two entities, with what each joins to", () => {
    const result = findJoinPath(registry, "ad_campaign", "account");
    expect(result.level).toBe("none");
    expect(result.paths).toEqual([]);
    expect(result.message).toContain("No declared path connects these two");
    expect(result.nearest).toEqual({
      from: [],
      to: ["close_lead", "crm_user", "organisation", "stripe_customer", "tag"],
    });
  });

  it("says when an end names nothing, with the closest entities", () => {
    const result = findJoinPath(registry, "subscriptons plan", "nope");
    expect(result.level).toBe("none");
    expect(result.from).toMatchObject({ kind: "unknown" });
    expect(result.from.closest?.[0]).toBe("subscription");
    expect(result.message).toContain('"subscriptons plan" and "nope" are not');
  });
});

describe("findJoinPath: raw tables", () => {
  it("joins two raw tables on the generated foreign keys", () => {
    const result = findJoinPath(
      registry,
      "crm_public.users",
      "crm_public.organisations",
    );
    expect(result.level).toBe("raw");
    expect(result.from).toEqual({
      input: "crm_public.users",
      kind: "table",
      table: "crm_public.users",
      entities: ["crm_user"],
    });
    expect(result.to.entities).toEqual(["account", "organisation"]);
    expect(result.paths[0].steps).toEqual([
      {
        relationship: "default_team",
        from: { model: "crm_public.users" },
        to: { model: "crm_public.teams" },
        join: [{ fromColumn: "default_team_id", toColumn: "id" }],
        on: "crm_public.users.default_team_id = crm_public.teams.id",
        cardinality: "many_to_one",
        status: "raw",
        source: "fk",
      },
      {
        relationship: "organisation",
        from: { model: "crm_public.teams" },
        to: { model: "crm_public.organisations" },
        join: [{ fromColumn: "organisation_id", toColumn: "id" }],
        on: "crm_public.teams.organisation_id = crm_public.organisations.id",
        cardinality: "many_to_one",
        status: "raw",
        source: "fk",
      },
    ]);
    expect(result.message).toContain("raw tables on foreign keys");
  });

  it("keeps one edge for a key listed from both tables, and inverts it", () => {
    const result = findJoinPath(registry, "teams", "crm_public.users");
    // `teams` alone is an entity synonym: the raw end is the table it is built from.
    expect(result.level).toBe("raw");
    const [step] = result.paths[0].steps;
    expect(step).toMatchObject({
      from: { model: "crm_public.teams" },
      to: { model: "crm_public.users" },
      cardinality: "one_to_many",
      join: [{ fromColumn: "id", toColumn: "default_team_id" }],
    });
    expect(step.alternatives).toBeUndefined();
    expect(step.fanOut).toContain("One crm_public.teams row matches many");
    // Whatever the order in the file, the record of the key holder names it.
    const reversed = parseOntologyRegistry(
      ONTOLOGY_GRAPH_YAML,
      ONTOLOGY_RAW_RELATIONSHIPS_YAML.replace(
        /( {2}- from_table: users[\s\S]*?in_bigquery: true\n)( {2}- from_table: teams[\s\S]*?in_bigquery: true\n)/,
        "$2$1",
      ),
    );
    expect(
      findJoinPath(reversed, "crm_public.users", "crm_public.teams").paths[0]
        .steps[0],
    ).toMatchObject({
      relationship: "default_team",
      cardinality: "many_to_one",
    });
  });

  it("notes a key the warehouse lacks or whose columns are inferred", () => {
    const result = findJoinPath(
      registry,
      "crm_public.activities_participants",
      "crm_public.users",
    );
    expect(result.paths[0].steps[0].notes).toEqual([
      "The warehouse does not hold both tables.",
      "The referenced columns are inferred from the primary key, not read from a constraint.",
    ]);
  });

  it("joins on every column of a composite key", () => {
    const [step] = findJoinPath(
      registry,
      "crm_public.leads",
      "crm_public.properties",
    ).paths[0].steps;
    expect(step.on).toBe(
      "crm_public.leads.tenant_id = crm_public.properties.tenant_id and crm_public.leads.property_id = crm_public.properties.id",
    );
  });

  it("prefers an entity path, and falls back to raw tables for entities", () => {
    // crm_user and crm_team have a declared (draft) relationship.
    expect(findJoinPath(registry, "crm_user", "crm_team").level).toBe("entity");
    // Without it, their raw tables still join.
    const noDraft = parseOntologyRegistry(
      ONTOLOGY_GRAPH_YAML.replace(
        / {2}- name: crm_user_has_primary_crm_team[\s\S]*?source: hasura_fk\n/,
        "",
      ).replace(
        / {2}- name: account_closed_by_crm_user[\s\S]*?source: declared\n/,
        "",
      ),
      ONTOLOGY_RAW_RELATIONSHIPS_YAML,
    );
    const result = findJoinPath(noDraft, "crm_user", "crm_team");
    expect(result.level).toBe("raw");
    expect(result.paths[0].steps[0].on).toBe(
      "crm_public.users.default_team_id = crm_public.teams.id",
    );
    expect(result.message).toContain("No entity relationship is declared");
  });

  it("never hides an entity path that is only too long behind a raw one", () => {
    // crm_user - crm_team: 1 raw foreign key. As entities, with the direct
    // relationship gone, the declared path is 3 hops (via account, organisation).
    const long = parseOntologyRegistry(
      ONTOLOGY_GRAPH_YAML.replace(
        / {2}- name: crm_user_has_primary_crm_team[\s\S]*?source: hasura_fk\n/,
        "",
      ),
      ONTOLOGY_RAW_RELATIONSHIPS_YAML,
    );
    const capped = findJoinPath(long, "crm_user", "crm_team", { maxHops: 2 });
    expect(capped.level).toBe("none");
    expect(capped.paths).toEqual([]);
    expect(capped.message).toBe(
      "No declared path within 2 hops. A path of 3 hops exists: pass maxHops: 3.",
    );
    expect(capped.nearest?.from).toEqual(["account"]);
    const full = findJoinPath(long, "crm_user", "crm_team", { maxHops: 3 });
    expect(full.level).toBe("entity");
    expect(full.paths[0].hops).toBe(3);
  });

  it("does not suggest a maxHops past the limit", () => {
    const names = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"];
    const chain = parseOntologyRegistry(`
entities:
${names.map(n => `  - {name: ${n}, canonical: {model: m_${n}, primary_key: id}}`).join("\n")}
relationships:
${names
  .slice(1)
  .map(
    (n, i) =>
      `  - {name: ${names[i]}_${n}, from: ${names[i]}, to: ${n}, cardinality: many_to_one, status: governed, join: [{from_column: next_id, to_column: id}]}`,
  )
  .join("\n")}
`);
    expect(findJoinPath(chain, "n0", "n6", { maxHops: 6 }).paths[0].hops).toBe(
      6,
    );
    const tooFar = findJoinPath(chain, "n0", "n7", { maxHops: 6 });
    expect(tooFar.paths).toEqual([]);
    expect(tooFar.message).toContain("7 hops, past the limit of 6");
  });

  it("says when no foreign key connects two raw tables", () => {
    const result = findJoinPath(
      registry,
      "crm_public.properties",
      "crm_public.users",
    );
    expect(result.level).toBe("none");
    expect(result.nearest).toEqual({
      from: ["crm_public.leads"],
      to: ["crm_public.activities", "crm_public.teams"],
    });
  });
});

describe("findJoinPath: absent and partial registries", () => {
  it("answers on an absent registry", () => {
    const result = findJoinPath(emptyRegistry("absent"), "account", "user");
    expect(result).toEqual({
      from: { input: "account", kind: "unknown", closest: [] },
      to: { input: "user", kind: "unknown", closest: [] },
      level: "none",
      paths: [],
      message:
        "The registry declares no entities and no relationships, so no join path is known.",
    });
  });

  it("answers on the first schema: entities, no relationships", () => {
    const first = parseOntologyRegistry(ONTOLOGY_REGISTRY_YAML);
    const result = findJoinPath(first, "account", "account");
    expect(result.level).toBe("none");
    expect(result.nearest).toEqual({ from: [], to: [] });
    const unknown = findJoinPath(first, "account", "subscription");
    expect(unknown.to).toMatchObject({ kind: "unknown", closest: ["account"] });
  });

  it("answers without the generated file", () => {
    const noRaw = parseOntologyRegistry(ONTOLOGY_GRAPH_YAML, null);
    expect(findJoinPath(noRaw, "subscription", "account").paths[0].hops).toBe(
      2,
    );
    expect(findJoinPath(noRaw, "crm_public.users", "account").from.kind).toBe(
      "unknown",
    );
    expect(findJoinPath(noRaw, "ad_campaign", "account").level).toBe("none");
  });
});

describe("relationshipsOfEntity", () => {
  it("lists an entity's relationships from its own side, governed first", () => {
    expect(relationshipsOfEntity(registry, "Account")).toEqual([
      {
        relationship: "account_closed_by_crm_user",
        with: "crm_user",
        model: "int_crm__users",
        cardinality: "many_to_one",
        join: [{ fromColumn: "closer_user_id", toColumn: "user_id" }],
        status: "governed",
      },
      {
        relationship: "account_is_organisation",
        with: "organisation",
        model: "stg_crm__organisations",
        cardinality: "one_to_one",
        join: [{ fromColumn: "organisation_id", toColumn: "organisation_id" }],
        status: "governed",
      },
      {
        relationship: "stripe_customer_belongs_to_account",
        with: "stripe_customer",
        model: "int_crm__customer_account",
        // Declared many_to_one from the customer: one_to_many from here.
        cardinality: "one_to_many",
        join: [{ fromColumn: "account_key", toColumn: "account_key" }],
        status: "governed",
      },
      {
        relationship: "account_has_close_lead",
        with: "close_lead",
        model: "int_close__leads",
        cardinality: "many_to_one",
        join: [{ fromColumn: "close_lead_id", toColumn: "lead_id" }],
        status: "draft",
      },
      {
        relationship: "account_has_tag",
        with: "tag",
        model: "stg_crm__tags",
        cardinality: "many_to_many",
        join: [{ fromColumn: "account_key", toColumn: "account_key" }],
        status: "draft",
      },
    ]);
    expect(relationshipsOfEntity(registry, "ad_campaign")).toEqual([]);
  });
});
