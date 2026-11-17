/**
 * Wise entity schemas, field for field the in-process connector's
 * (`api/src/connectors/wise/schema.ts`). The parity harness in `fixtures/`
 * fails if the two drift.
 *
 * Mako's system columns (`_syncedAt`, `is_deleted`, `_mako_*`, ...) are not
 * declared here: the box path merges them in (`jsonSchemaToEntitySchema`).
 * `id` is the one required, non-null column, as in-process.
 */

export type FieldType =
  "id" | "string" | "timestamp" | "number" | "integer" | "boolean" | "json";
type Fields = Record<string, FieldType>;

export const PROFILE_SCHEMA: Fields = {
  id: "id",
  publicId: "string",
  userId: "integer",
  type: "string",
  email: "string",
  createdAt: "timestamp",
  updatedAt: "timestamp",
  version: "integer",
  obfuscated: "boolean",
  avatar: "string",
  currentState: "string",
  firstName: "string",
  lastName: "string",
  fullName: "string",
  businessName: "string",
  registrationNumber: "string",
  companyType: "string",
  companyRole: "string",
  phoneNumber: "string",
  dateOfBirth: "string",
  jointProfile: "boolean",
  partner: "boolean",
  partnerCustomer: "boolean",
  contractingWithWise: "boolean",
  dataObfuscated: "boolean",
  address: "json",
  contactDetails: "json",
  industryCategories: "json",
  operationalAddresses: "json",
  secondaryAddresses: "json",
  firstLevelCategory: "string",
  secondLevelCategory: "string",
  descriptionOfBusiness: "string",
  webpage: "string",
};

export const BALANCE_SCHEMA: Fields = {
  id: "id",
  profileId: "string",
  currency: "string",
  type: "string",
  name: "string",
  icon: "string",
  investmentState: "string",
  creationTime: "timestamp",
  modificationTime: "timestamp",
  visible: "boolean",
  primary: "boolean",
  groupId: "string",
  recipientId: "integer",
  amount: "json",
  reservedAmount: "json",
  cashAmount: "json",
  totalWorth: "json",
};

// Webhook-driven ledger of credits/debits (`balances#update`).
export const BALANCE_UPDATE_SCHEMA: Fields = {
  id: "id",
  balance_id: "integer",
  profile_id: "integer",
  resource_id: "integer",
  resource_type: "string",
  amount: "number",
  currency: "string",
  channel_name: "string",
  transaction_type: "string",
  transfer_reference: "string",
  post_transaction_balance_amount: "number",
  step_id: "integer",
  occurred_at: "timestamp",
  subscription_id: "string",
  event_type: "string",
  schema_version: "string",
  sent_at: "timestamp",
};

export const TRANSFER_SCHEMA: Fields = {
  id: "id",
  user: "integer",
  targetAccount: "integer",
  sourceAccount: "integer",
  quote: "string",
  quoteUuid: "string",
  status: "string",
  // Populated by transfers#state-change webhooks (sparse upsert).
  previous_state: "string",
  current_state: "string",
  occurred_at: "timestamp",
  reference: "string",
  rate: "number",
  created: "timestamp",
  business: "integer",
  profile_id: "integer",
  account_id: "integer",
  transferRequest: "string",
  hasActiveIssues: "boolean",
  sourceCurrency: "string",
  sourceValue: "number",
  targetCurrency: "string",
  targetValue: "number",
  customerTransactionId: "string",
  details: "json",
  // transfers#refund / transfers#payout-failure extras
  failure_reason_code: "string",
  failure_description: "string",
  refund_amount: "number",
  refund_currency: "string",
};

export const RECIPIENT_SCHEMA: Fields = {
  id: "id",
  creatorId: "integer",
  profileId: "integer",
  currency: "string",
  country: "string",
  type: "string",
  legalEntityType: "string",
  email: "string",
  active: "boolean",
  nickname: "string",
  accountSummary: "string",
  longAccountSummary: "string",
  hash: "string",
  isDefaultAccount: "boolean",
  isInternal: "boolean",
  ownedByCustomer: "boolean",
  // recipients#state-change webhook fields
  current_state: "string",
  previous_state: "string",
  occurred_at: "timestamp",
  name: "json",
  details: "json",
  commonFieldMap: "json",
  displayFields: "json",
  additionalDisplayDetails: "json",
};

export const ACTIVITY_SCHEMA: Fields = {
  id: "id",
  profileId: "string",
  type: "string",
  title: "string",
  description: "string",
  primaryAmount: "string",
  secondaryAmount: "string",
  status: "string",
  createdOn: "timestamp",
  updatedOn: "timestamp",
  resource: "json",
};

export const BALANCE_STATEMENT_SCHEMA: Fields = {
  id: "id",
  profileId: "string",
  balanceId: "string",
  currency: "string",
  referenceNumber: "string",
  type: "string",
  date: "timestamp",
  amount: "number",
  totalFees: "number",
  runningBalance: "number",
  detailsType: "string",
  description: "string",
  details: "json",
  exchangeDetails: "json",
};

export const WISE_ENTITY_SCHEMA_MAP: Record<string, Fields> = {
  profiles: PROFILE_SCHEMA,
  balances: BALANCE_SCHEMA,
  balance_updates: BALANCE_UPDATE_SCHEMA,
  transfers: TRANSFER_SCHEMA,
  recipients: RECIPIENT_SCHEMA,
  activities: ACTIVITY_SCHEMA,
  balance_statements: BALANCE_STATEMENT_SCHEMA,
};

/** Field type -> JSON Schema, as `discover` emits it. */
const JSON_SCHEMA_TYPES: Record<FieldType, Record<string, unknown>> = {
  id: { type: "string" },
  string: { type: ["null", "string"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  integer: { type: ["null", "integer"] },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array"] },
};

/** The SDK shorthand (the `schema` the SDK checks a cursor field against). */
export function wiseShorthandSchema(entity: string): Record<string, string> {
  const fields = WISE_ENTITY_SCHEMA_MAP[entity];
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  return Object.fromEntries(
    Object.entries(fields).map(([name, type]) => [
      name,
      type === "id" ? "string" : type,
    ]),
  );
}

/** The stream's JSON Schema. `id` is the only required, non-null field. */
export function wiseJsonSchema(entity: string): Record<string, unknown> {
  const fields = WISE_ENTITY_SCHEMA_MAP[entity];
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
    properties[name] = { ...JSON_SCHEMA_TYPES[type] };
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
