/**
 * Test fixtures for the ontology lookups: a small dbt manifest + catalog in
 * dbt's own shape (BigQuery relation names), and a registry file in the
 * workspace schema (`dbt/ontology/terms.yml`).
 */
import type { RawCatalog, RawManifest } from "../ontology/manifest-index";

export const ONTOLOGY_MANIFEST: RawManifest = {
  metadata: {
    generated_at: "2026-11-12T04:00:00Z",
    project_name: "analytics",
  },
  nodes: {
    "model.analytics.fct_account_product_month": {
      name: "fct_account_product_month",
      resource_type: "model",
      original_file_path: "models/marts/finance/fct_account_product_month.sql",
      description:
        "Monthly recurring revenue per account and product. Grain: account x product x month.",
      tags: ["finance", "governed"],
      meta: { owner: "finance" },
      group: "finance",
      access: "public",
      relation_name: "`acme-prod`.`dbt_prod`.`fct_account_product_month`",
      config: { materialized: "table", contract: { enforced: true } },
      columns: {
        account_id: { name: "account_id", description: "The paying account." },
        product: { name: "product", description: "Subscription product." },
        month: { name: "month", data_type: "date" },
        mrr_eur: {
          name: "mrr_eur",
          description: "Monthly recurring revenue in EUR, VAT excluded.",
        },
      },
      depends_on: {
        nodes: [
          "model.analytics.int_subscriptions__periods",
          "model.analytics.dim_account",
        ],
      },
    },
    "model.analytics.int_subscriptions__periods": {
      name: "int_subscriptions__periods",
      resource_type: "model",
      original_file_path: "models/intermediate/int_subscriptions__periods.sql",
      description: "One row per subscription period.",
      relation_name: "`acme-prod`.`dbt_prod`.`int_subscriptions__periods`",
      config: { materialized: "view" },
      columns: {
        subscription_id: { name: "subscription_id" },
      },
      depends_on: { nodes: ["source.analytics.stripe.subscriptions"] },
    },
    "model.analytics.int_fr_renewals__contract_periods": {
      name: "int_fr_renewals__contract_periods",
      resource_type: "model",
      original_file_path:
        "models/intermediate/int_fr_renewals__contract_periods.sql",
      description: "French renewal contract periods with their own MRR.",
      relation_name:
        "`acme-prod`.`dbt_prod`.`int_fr_renewals__contract_periods`",
      config: { materialized: "table" },
      columns: {
        contract_id: { name: "contract_id" },
        mrr: { name: "mrr", description: "Contract MRR, VAT included." },
      },
      depends_on: { nodes: [] },
    },
    "model.analytics.dim_account": {
      name: "dim_account",
      resource_type: "model",
      original_file_path: "models/marts/core/dim_account.sql",
      description: "One row per account (customer organisation).",
      meta: { grain: ["account_id"] },
      relation_name: "`acme-prod`.`dbt_prod`.`dim_account`",
      config: { materialized: "table" },
      columns: {
        account_id: { name: "account_id", description: "Primary key." },
        name: { name: "name" },
      },
      depends_on: { nodes: ["source.analytics.crm.organisations"] },
    },
    "seed.analytics.country_codes": {
      name: "country_codes",
      resource_type: "seed",
      original_file_path: "seeds/country_codes.csv",
      description: "ISO country codes.",
      relation_name: "`acme-prod`.`dbt_prod`.`country_codes`",
      columns: {},
    },
    "test.analytics.not_null_fct_account_product_month_account_id.1": {
      name: "not_null_fct_account_product_month_account_id",
      resource_type: "test",
      attached_node: "model.analytics.fct_account_product_month",
      column_name: "account_id",
      test_metadata: { name: "not_null" },
      depends_on: { nodes: ["model.analytics.fct_account_product_month"] },
    },
    "test.analytics.unique_dim_account_account_id.2": {
      name: "unique_dim_account_account_id",
      resource_type: "test",
      attached_node: "model.analytics.dim_account",
      column_name: "account_id",
      test_metadata: { name: "unique" },
      depends_on: { nodes: ["model.analytics.dim_account"] },
    },
    "test.analytics.fct_grain_is_unique.3": {
      name: "fct_grain_is_unique",
      resource_type: "test",
      attached_node: "model.analytics.fct_account_product_month",
      test_metadata: {
        name: "unique_combination_of_columns",
        namespace: "dbt_utils",
      },
      depends_on: { nodes: ["model.analytics.fct_account_product_month"] },
    },
  },
  sources: {
    "source.analytics.stripe.subscriptions": {
      name: "subscriptions",
      source_name: "stripe",
      resource_type: "source",
      description: "Raw Stripe subscriptions.",
      relation_name: "`acme-prod`.`stripe`.`subscriptions`",
      columns: { id: { name: "id", description: "Stripe subscription id." } },
    },
    "source.analytics.crm.organisations": {
      name: "organisations",
      source_name: "crm",
      resource_type: "source",
      description: "CRM organisations.",
      relation_name: "`acme-prod`.`crm_public`.`organisations`",
      columns: {},
    },
  },
  exposures: {
    "exposure.analytics.finance_dashboard": {
      name: "finance_dashboard",
      label: "Finance dashboard",
      type: "dashboard",
      url: "https://example.test/finance",
      owner: { name: "Finance" },
      depends_on: { nodes: ["model.analytics.fct_account_product_month"] },
    },
  },
  parent_map: {
    "model.analytics.fct_account_product_month": [
      "model.analytics.int_subscriptions__periods",
      "model.analytics.dim_account",
    ],
    "model.analytics.int_subscriptions__periods": [
      "source.analytics.stripe.subscriptions",
    ],
    "model.analytics.dim_account": ["source.analytics.crm.organisations"],
    "test.analytics.not_null_fct_account_product_month_account_id.1": [
      "model.analytics.fct_account_product_month",
    ],
    "exposure.analytics.finance_dashboard": [
      "model.analytics.fct_account_product_month",
    ],
  },
};

export const ONTOLOGY_CATALOG: RawCatalog = {
  nodes: {
    "model.analytics.fct_account_product_month": {
      columns: {
        account_id: { name: "account_id", type: "STRING", index: 1 },
        product: { name: "product", type: "STRING", index: 2 },
        month: { name: "month", type: "DATE", index: 3 },
        mrr_eur: { name: "mrr_eur", type: "NUMERIC", index: 4 },
        loaded_at: { name: "loaded_at", type: "TIMESTAMP", index: 5 },
      },
    },
  },
  sources: {},
};

/** The registry file, in the schema the workspace repo ships. */
export const ONTOLOGY_REGISTRY_YAML = `version: 1
terms:
  - name: mrr
    label: MRR
    definition: >-
      Monthly recurring revenue: the monthly value of active subscriptions,
      in EUR, VAT excluded.
    owner: finance
    status: governed
    canonical: {model: fct_account_product_month, column: mrr_eur}
    grain: account x product x month
    synonyms: [monthly recurring revenue]
    forbidden_patterns:
      - {regex: 'sum\\(.*amount.*\\)\\s*/\\s*12', message: 'Read mrr_eur from fct_account_product_month.', paths: ['dbt/models/**', 'apps/**/bindings/**']}
    known_variants:
      - {model: int_fr_renewals__contract_periods, difference: 'Contract MRR, VAT included, France only.'}
  - name: paying_customer
    label: Paying customer
    definition: >-
      An account with at least one active paid subscription.
    owner: finance
    status: draft
    canonical: {model: dim_account, column: is_paying}
    synonyms: [paying customers, active customer]
entities:
  - name: account
    label: Account
    definition: >-
      A customer organisation.
    owner: sales-ops
    canonical: {model: dim_account, primary_key: account_id}
    sources: [crm_public.organisations]
    synonyms: [organisation, customer organisation]
`;

/**
 * The registry with entities and relationships, in the shape of the
 * workspace file: identities, composite keys, open points, governed and
 * draft relationships, two relationships between one pair, a cycle
 * (account - organisation - team - user - account) and a self relationship.
 */
export const ONTOLOGY_GRAPH_YAML = `version: 1
terms:
  - name: mrr
    label: MRR
    definition: Monthly recurring revenue.
    owner: finance
    status: governed
    canonical: {model: fct_account_product_month, column: mrr_eur}
entities:
  - name: account
    label: Account
    definition: >-
      A CRM organisation that links to at least one Stripe customer.
    owner: data
    status: governed
    canonical: {model: dim_account, primary_key: account_key}
    grain: one row per CRM organisation with at least one Stripe customer
    sources: [crm_public.organisations, int_crm__customer_account]
    identities:
      - {system: crm, column: organisation_id, resolver: dim_account}
      - {system: stripe, column: customer_id, resolver: int_crm__customer_account}
      - {system: close, column: close_lead_id}
    synonyms: [customer account, customer, client]
    known_variants:
      - {model: int_fr_renewals__identity, difference: 'FR only. Maps a Stripe customer to a Close lead.'}
  - name: organisation
    label: Organisation
    definition: A legal entity in the CRM.
    owner: data
    status: governed
    canonical: {model: stg_crm__organisations, primary_key: organisation_id}
    grain: one row per CRM organisation
    sources: [crm_public.organisations]
    synonyms: [org, company]
  - name: crm_team
    label: Team (agency)
    definition: The public agency profile in the CRM.
    owner: data
    status: draft
    open_point: >-
      stg_crm__teams keeps only teams with an organisation_id.
    canonical: {model: stg_crm__teams, primary_key: team_id}
    grain: one row per team
    sources: [crm_public.teams]
    synonyms: [agency, team]
  - name: crm_user
    label: CRM user
    definition: A person with a CRM login.
    owner: data
    status: governed
    canonical: {model: int_crm__users, primary_key: user_id}
    grain: one row per user
    sources: [crm_public.users]
    synonyms: [user, agent]
  - name: stripe_customer
    label: Stripe customer
    definition: A Stripe customer linked to an organisation.
    owner: finance
    status: governed
    canonical: {model: int_crm__customer_account, primary_key: customer_id}
    grain: one row per Stripe customer
    sources: [stripe.customers]
    synonyms: [payer]
  - name: subscription
    label: Subscription
    definition: A Stripe subscription.
    owner: finance
    status: governed
    canonical: {model: stg_stripe__subscriptions, primary_key: subscription_id}
    grain: one row per subscription
    sources: [stripe.subscriptions]
    synonyms: [sub, contract]
  - name: demo
    label: Demo
    definition: A sales demo.
    owner: sales
    status: draft
    open_point: The demo key is per country.
    canonical: {model: fct_intl_sales_demos, primary_key: [country, demo_key]}
    grain: one row per demo
    sources: []
    synonyms: [meeting]
  - name: close_lead
    label: Close lead
    definition: A prospect agency in Close.
    owner: sales
    status: draft
    open_point: Lead ids repeat across countries.
    canonical: {model: int_close__leads, primary_key: lead_id}
    grain: one row per Close lead
    sources: []
    synonyms: [prospect]
  - name: tag
    label: Tag
    definition: A label on an account.
    owner: data
    status: draft
    open_point: No model yet.
    canonical: {model: stg_crm__tags, primary_key: tag_id}
    grain: one row per tag
    sources: []
    synonyms: []
  - name: ad_campaign
    label: Ad campaign
    definition: A paid campaign.
    owner: marketing
    status: draft
    open_point: No key to an account.
    canonical: {model: fct_ad_spend_daily, primary_key: [country, platform, campaign_id]}
    grain: one row per campaign per day
    sources: []
    synonyms: [campaign]
relationships:
  - name: account_is_organisation
    from: account
    to: organisation
    cardinality: one_to_one
    join:
      - {from_column: organisation_id, to_column: organisation_id}
    status: governed
    source: declared
    evidence: '0 orphans in 10,315 rows.'
  - name: stripe_customer_belongs_to_account
    from: stripe_customer
    to: account
    cardinality: many_to_one
    join:
      - {from_column: account_key, to_column: account_key}
    status: governed
    source: declared
  - name: stripe_customer_belongs_to_organisation
    from: stripe_customer
    to: organisation
    cardinality: many_to_one
    join:
      - {from_column: organisation_id, to_column: organisation_id}
    status: governed
    source: declared
  - name: subscription_belongs_to_stripe_customer
    from: subscription
    to: stripe_customer
    cardinality: many_to_one
    join:
      - {from_column: customer_id, to_column: customer_id}
    status: governed
    source: hasura_fk
  - name: crm_team_belongs_to_organisation
    from: crm_team
    to: organisation
    cardinality: many_to_one
    join:
      - {from_column: organisation_id, to_column: organisation_id}
    status: governed
    source: hasura_fk
  - name: crm_team_billed_to_organisation
    from: crm_team
    to: organisation
    cardinality: many_to_one
    join:
      - {from_column: billing_organisation_id, to_column: organisation_id}
    status: draft
    source: mined
    open_point: The column is null on two-thirds of teams.
  - name: crm_user_has_primary_crm_team
    from: crm_user
    to: crm_team
    cardinality: many_to_one
    join:
      - {from_column: team_id, to_column: team_id}
    status: draft
    source: hasura_fk
  - name: account_closed_by_crm_user
    from: account
    to: crm_user
    cardinality: many_to_one
    join:
      - {from_column: closer_user_id, to_column: user_id}
    status: governed
    source: declared
  - name: organisation_has_parent_organisation
    from: organisation
    to: organisation
    cardinality: many_to_one
    join:
      - {from_column: parent_organisation_id, to_column: organisation_id}
    status: draft
    source: declared
  - name: demo_belongs_to_close_lead
    from: demo
    to: close_lead
    cardinality: many_to_one
    join:
      - {from_column: lead_id, to_column: lead_id}
      - {from_column: country, to_column: country}
    status: draft
    source: mined
  - name: account_has_close_lead
    from: account
    to: close_lead
    cardinality: many_to_one
    join:
      - {from_column: close_lead_id, to_column: lead_id}
    status: draft
    source: declared
  - name: account_has_tag
    from: account
    to: tag
    cardinality: many_to_many
    join:
      - {from_column: account_key, to_column: account_key}
    status: draft
    source: mined
`;

/**
 * The generated raw-relationships file, in the shape the import script
 * writes: a mapping with `source`, `counts` and `relationships`; bare
 * table names; `hasura_name`; each foreign key listed from both tables.
 */
export const ONTOLOGY_RAW_RELATIONSHIPS_YAML = `# GENERATED. Do not edit by hand.
source:
  repo: example/mono
  commit: b84619128aee977effc12c79f6cd4d40e2bcf39d
counts:
  tables: 5
  relationships: 7
relationships:
  - from_table: users
    from_columns: [default_team_id]
    to_table: teams
    to_columns: [id]
    cardinality: many_to_one
    hasura_name: default_team
    kind: fk
    in_bigquery: true
  - from_table: teams
    from_columns: [id]
    to_table: users
    to_columns: [default_team_id]
    cardinality: one_to_many
    hasura_name: default_team_users
    kind: fk
    in_bigquery: true
  - from_table: teams
    from_columns: [organisation_id]
    to_table: organisations
    to_columns: [id]
    cardinality: many_to_one
    hasura_name: organisation
    kind: fk
    in_bigquery: true
  - from_table: activities
    from_columns: [assigned_to]
    to_table: users
    to_columns: [id]
    cardinality: many_to_one
    hasura_name: assignee
    kind: fk
    in_bigquery: true
  - from_table: activities
    from_columns: [id]
    to_table: activities_participants
    to_columns: [activity_id]
    cardinality: one_to_many
    hasura_name: activities_participants
    kind: manual
    in_bigquery: false
    inferred: true
  - from_table: leads
    from_columns: [tenant_id, property_id]
    to_table: properties
    to_columns: [tenant_id, id]
    cardinality: many_to_one
    hasura_name: property
    kind: manual
    in_bigquery: true
  - from_table: orphans
    from_columns: [a, b]
    to_table: users
    to_columns: [id]
    cardinality: many_to_one
    hasura_name: broken_columns
    kind: fk
`;
