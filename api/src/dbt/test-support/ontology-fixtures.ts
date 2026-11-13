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
