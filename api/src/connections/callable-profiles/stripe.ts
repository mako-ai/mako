/**
 * Stripe, as a call_connection profile: data only, no connector folder. The
 * request side (bearer key, form bodies, the two caller headers) moved here
 * unchanged from callable.ts; the schema is the connector's getConfigSchema().
 */
import { text, trimSlash, type CallableConnection } from "../callable";
import {
  OPERATION_DEFAULT_LIMIT,
  OPERATION_MAX_LIMIT,
  idParam,
  limitParam,
  param,
  required,
  type ConnectionOperation,
} from "../operations";
import type { CallableProfile } from ".";

const stripeCallable: CallableConnection = {
  type: "stripe",
  baseUrl: config =>
    trimSlash(text(config.api_base_url) || "https://api.stripe.com"),
  baseUrlFields: ["api_base_url"],
  credential: config => ({ type: "bearer", token: text(config.api_key) }),
  callerHeaders: ["stripe-version", "stripe-account"],
  bodyEncoding: "form",
};

function stripeOperations(): ConnectionOperation[] {
  const LIMIT = param(
    "limit",
    `Records per page (default ${OPERATION_DEFAULT_LIMIT}, max ${OPERATION_MAX_LIMIT}).`,
  );
  return [
    {
      name: "search_customers",
      description:
        "Search customers with Stripe's search syntax, e.g. `email:'a@b.com'` or `name~'Dupont'`.",
      params: [param("query", "Stripe search query.", true), LIMIT],
      build: params => ({
        method: "GET",
        path: "/v1/customers/search",
        query: { query: required(params, "query"), limit: limitParam(params) },
      }),
    },
    {
      name: "get_customer",
      description: "One customer.",
      params: [param("id", "Customer id (cus_…).", true)],
      build: params => ({
        method: "GET",
        path: `/v1/customers/${idParam(params, "id")}`,
      }),
    },
    {
      name: "list_subscriptions",
      description: "A customer's subscriptions, every status.",
      params: [param("customer", "Customer id (cus_…).", true), LIMIT],
      build: params => ({
        method: "GET",
        path: "/v1/subscriptions",
        query: {
          customer: required(params, "customer"),
          status: "all",
          limit: limitParam(params),
        },
      }),
    },
    {
      name: "list_invoices",
      description: "A customer's invoices, newest first.",
      params: [param("customer", "Customer id (cus_…).", true), LIMIT],
      build: params => ({
        method: "GET",
        path: "/v1/invoices",
        query: {
          customer: required(params, "customer"),
          limit: limitParam(params),
        },
      }),
    },
  ];
}

export const stripeProfile: CallableProfile = {
  type: "stripe",
  callable: stripeCallable,
  operations: () => stripeOperations(),
  configSchema: {
    fields: [
      {
        name: "api_key",
        label: "API Key",
        type: "password",
        required: true,
        helperText: "Your Stripe secret API key",
      },
      {
        name: "api_base_url",
        label: "API Base URL",
        type: "string",
        required: false,
        default: "https://api.stripe.com",
      },
    ],
  },
};
