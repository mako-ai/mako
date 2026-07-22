import {
  type ConnectorEntitySchema,
  type ConnectorFieldSchema,
  MAKO_SYSTEM_FIELDS,
} from "../base/BaseConnector";

const s = (nullable = true): ConnectorFieldSchema => ({
  type: "string",
  nullable,
});
const ts = (nullable = true): ConnectorFieldSchema => ({
  type: "timestamp",
  nullable,
});
const n = (nullable = true): ConnectorFieldSchema => ({
  type: "number",
  nullable,
});
const i = (nullable = true): ConnectorFieldSchema => ({
  type: "integer",
  nullable,
});
const b = (nullable = true): ConnectorFieldSchema => ({
  type: "boolean",
  nullable,
});
const j = (nullable = true): ConnectorFieldSchema => ({
  type: "json",
  nullable,
});

export const PROFILE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  publicId: s(),
  userId: i(),
  type: s(),
  email: s(),
  createdAt: ts(),
  updatedAt: ts(),
  version: i(),
  obfuscated: b(),
  avatar: s(),
  currentState: s(),
  firstName: s(),
  lastName: s(),
  fullName: s(),
  businessName: s(),
  registrationNumber: s(),
  companyType: s(),
  companyRole: s(),
  phoneNumber: s(),
  dateOfBirth: s(),
  jointProfile: b(),
  partner: b(),
  partnerCustomer: b(),
  contractingWithWise: b(),
  dataObfuscated: b(),
  address: j(),
  contactDetails: j(),
  industryCategories: j(),
  operationalAddresses: j(),
  secondaryAddresses: j(),
  firstLevelCategory: s(),
  secondLevelCategory: s(),
  descriptionOfBusiness: s(),
  webpage: s(),
  ...MAKO_SYSTEM_FIELDS,
};

export const BALANCE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  profileId: s(),
  currency: s(),
  type: s(),
  name: s(),
  icon: s(),
  investmentState: s(),
  creationTime: ts(),
  modificationTime: ts(),
  visible: b(),
  primary: b(),
  groupId: s(),
  recipientId: i(),
  amount: j(),
  reservedAmount: j(),
  cashAmount: j(),
  totalWorth: j(),
  ...MAKO_SYSTEM_FIELDS,
};

// Webhook-driven ledger of credits/debits (`balances#update`).
export const BALANCE_UPDATE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  balance_id: i(),
  profile_id: i(),
  resource_id: i(),
  resource_type: s(),
  amount: n(),
  currency: s(),
  channel_name: s(),
  transaction_type: s(),
  transfer_reference: s(),
  post_transaction_balance_amount: n(),
  step_id: i(),
  occurred_at: ts(),
  subscription_id: s(),
  event_type: s(),
  schema_version: s(),
  sent_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const TRANSFER_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  user: i(),
  targetAccount: i(),
  sourceAccount: i(),
  quote: s(),
  quoteUuid: s(),
  status: s(),
  // Populated by transfers#state-change webhooks (sparse upsert).
  previous_state: s(),
  current_state: s(),
  occurred_at: ts(),
  reference: s(),
  rate: n(),
  created: ts(),
  business: i(),
  profile_id: i(),
  account_id: i(),
  transferRequest: s(),
  hasActiveIssues: b(),
  sourceCurrency: s(),
  sourceValue: n(),
  targetCurrency: s(),
  targetValue: n(),
  customerTransactionId: s(),
  details: j(),
  // transfers#refund / transfers#payout-failure extras
  failure_reason_code: s(),
  failure_description: s(),
  refund_amount: n(),
  refund_currency: s(),
  ...MAKO_SYSTEM_FIELDS,
};

export const RECIPIENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  creatorId: i(),
  profileId: i(),
  currency: s(),
  country: s(),
  type: s(),
  legalEntityType: s(),
  email: s(),
  active: b(),
  nickname: s(),
  accountSummary: s(),
  longAccountSummary: s(),
  hash: s(),
  isDefaultAccount: b(),
  isInternal: b(),
  ownedByCustomer: b(),
  // recipients#state-change webhook fields
  current_state: s(),
  previous_state: s(),
  occurred_at: ts(),
  name: j(),
  details: j(),
  commonFieldMap: j(),
  displayFields: j(),
  additionalDisplayDetails: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const ACTIVITY_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  profileId: s(),
  type: s(),
  title: s(),
  description: s(),
  primaryAmount: s(),
  secondaryAmount: s(),
  status: s(),
  createdOn: ts(),
  updatedOn: ts(),
  resource: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const WISE_ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  profiles: PROFILE_SCHEMA,
  balances: BALANCE_SCHEMA,
  balance_updates: BALANCE_UPDATE_SCHEMA,
  transfers: TRANSFER_SCHEMA,
  recipients: RECIPIENT_SCHEMA,
  activities: ACTIVITY_SCHEMA,
};

export function resolveWiseEntitySchema(
  entity: string,
): ConnectorEntitySchema | null {
  const fields = WISE_ENTITY_SCHEMA_MAP[entity];
  if (!fields) {
    return null;
  }

  return {
    entity,
    fields,
    unknownFieldPolicy: "string",
    keyColumns: ["id"],
  };
}
