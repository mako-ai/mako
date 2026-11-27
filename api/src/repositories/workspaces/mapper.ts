/**
 * Bidirectional MongoDB <-> DTO <-> Postgres mappers for the 10 tables in the
 * Phase 1B `workspaces_core` + `github_installations` domain (Decision #3).
 *
 * Pure functions only (no I/O) so the repositories, backfill/verifier, and
 * sync-retry replayer share ONE translation per table.
 *
 * Invariants:
 *   - ObjectId <-> UUIDv8 via `objectIdToUuid` / `toWireId`; DTOs always hold 24-hex wire ids.
 *   - `undefined` <-> NULL fidelity for optional fields; `apiKeys[].scopes` absent <-> NULL.
 *   - Legacy `apiKeys[]` subdocs missing `_id` get a deterministic 24-hex SHA-256 fallback id.
 *   - Legacy `appsRepo` normalizes into `workspaceRepos` on read.
 *   - Encrypted `workflows.hatchetToken` / `workflows.webhooks` are copied opaque.
 *   - Invites without timestamps derive `createdAt` from the ObjectId timestamp.
 *   - Postgres user columns are native `uuid` (Decision #3): callers supply a
 *     `resolveUserUuid` mapping (nullable audit columns accept `null`; grant-bearing
 *     columns require a valid UUID).
 */
import { createHash } from "node:crypto";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  objectIdUuidTimestamp,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import type {
  AcpPlanGrantRow,
  GitHubAccountType,
  GitHubInstallationRow,
  GitHubRepoSelection,
  McpOAuthClientRow,
  McpOAuthCodeRow,
  McpOAuthTokenRow,
  NewAcpPlanGrantRow,
  NewGitHubInstallationRow,
  NewMcpOAuthClientRow,
  NewMcpOAuthCodeRow,
  NewMcpOAuthTokenRow,
  NewWorkspaceApiKeyRow,
  NewWorkspaceInviteRow,
  NewWorkspaceMemberRow,
  NewWorkspaceRow,
  NewWorkspaceUserHandleRow,
  WorkflowSlotJson,
  WorkspaceApiKeyRow,
  WorkspaceInviteRow,
  WorkspaceMemberRow,
  WorkspaceRepoBindingJson,
  WorkspaceRow,
  WorkspaceUserHandleRow,
} from "../../database/pg/schema/workspaces";
import { coerceDate, stripUndefinedDeep } from "../auth/mapper";
import type {
  AcpPlanGrantRecord,
  BillingPlan,
  BillingTier,
  GitHubInstallationRecord,
  McpOAuthClientRecord,
  McpOAuthCodeRecord,
  McpOAuthTokenRecord,
  SubscriptionStatus,
  WorkflowSlot,
  WorkspaceApiKeyRecord,
  WorkspaceApiKeyScope,
  WorkspaceAutoJoin,
  WorkspaceBilling,
  WorkspaceInviteRecord,
  WorkspaceInviteRole,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
  WorkspaceRecord,
  WorkspaceRepoBinding,
  WorkspaceSettings,
  WorkspaceUserHandleRecord,
  WorkspaceWorkflows,
} from "./types";

// ── id & primitive helpers ───────────────────────────────────────────────

type IdLike = string | { toString(): string } | null | undefined;

/** Maps a DTO/Mongo userId to its Postgres `users.id` UUID (or `null` when unresolvable). */
export type NullableUserUuidMapper = (userId: string) => string | null;

/** Maps a DTO/Mongo userId to its required Postgres `users.id` UUID (throws if unresolvable). */
export type RequiredUserUuidMapper = (userId: string) => string;

/** Maps a Postgres `users.id` UUID back to the Mongo user `_id` (`legacyId ?? id`) for Stage 4 reverse-sync. */
export type MongoUserIdMapper = (userId: string) => string;

const defaultNullableUserUuid: NullableUserUuidMapper = userId =>
  userId && isUuidString(userId) ? userId.toLowerCase() : null;

const defaultRequiredUserUuid: RequiredUserUuidMapper = userId => {
  if (userId && isUuidString(userId)) {
    return userId.toLowerCase();
  }
  throw new Error(
    `Cannot map userId ${JSON.stringify(userId)} to a Postgres UUID without a resolved user map`,
  );
};

const identityUserId: MongoUserIdMapper = userId => userId;

/** Lowercase 24-hex wire id from an ObjectId / hex string / UUID; throws on junk. */
export function toWire(id: IdLike): string {
  if (id == null) {
    throw new Error("Missing id");
  }
  const parsed = parseEntityId(String(id));
  if (!parsed) {
    throw new Error(`Invalid entity id: ${JSON.stringify(String(id))}`);
  }
  return parsed.oid ?? parsed.uuid;
}

/** Postgres UUID from a wire id (24-hex or UUID); throws on junk. */
export function toPgUuid(id: IdLike): string {
  if (id == null) {
    throw new Error("Missing id");
  }
  const parsed = parseEntityId(String(id));
  if (!parsed) {
    throw new Error(`Invalid entity id: ${JSON.stringify(String(id))}`);
  }
  return parsed.uuid;
}

/** True if `id` is a usable workspace/entity id in either encoding. */
export function isEntityId(id: unknown): id is string {
  return typeof id === "string" && parseEntityId(id) !== null;
}

/**
 * Deterministic 24-hex fallback id for legacy `workspaces.apiKeys[]` subdocuments
 * that lack an `_id`. Real subdocs always preserve their exact `_id`.
 */
export function fallbackApiKeyId(workspaceId: string, keyHash: string): string {
  return createHash("sha256")
    .update(`${workspaceId.toLowerCase()}:${keyHash}`)
    .digest("hex")
    .slice(0, 24);
}

function optDate(value: unknown): Date | undefined {
  if (value == null) {
    return undefined;
  }
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function nullableDate(value: unknown): Date | null {
  return optDate(value) ?? null;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function optStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringArray(value) : undefined;
}

function deriveCreatedAtFromWireId(id: string): Date {
  if (isObjectIdHex(id)) {
    return objectIdUuidTimestamp(objectIdToUuid(id)) ?? new Date(0);
  }
  return new Date(0);
}

// ── 1. workspaces ────────────────────────────────────────────────────────

/** Loose shape of a lean Mongo `workspaces` document. */
export interface MongoWorkspaceLike {
  _id: IdLike;
  name?: string;
  slug?: string;
  createdBy?: string;
  settings?: Record<string, unknown> | null;
  billing?: Record<string, unknown> | null;
  workspaceRepos?: unknown[] | null;
  appsRepo?: Record<string, unknown> | null;
  workflows?: Record<string, unknown> | null;
  apiKeys?: MongoApiKeyLike[] | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

const BILLING_TIERS = new Set<BillingTier>(["free", "pro", "enterprise"]);
const SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  "active",
  "past_due",
  "canceled",
  "trialing",
  "incomplete",
]);

export function normalizeAutoJoin(raw: unknown): WorkspaceAutoJoin | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  return {
    domains: stringArray(r.domains).map(d => d.trim().toLowerCase()),
    role: r.role === "member" ? "member" : "viewer",
  };
}

export function normalizeSettings(
  raw: Record<string, unknown> | null | undefined,
): WorkspaceSettings {
  const s = raw ?? {};
  const out: WorkspaceSettings = {
    maxDatabases: optNumber(s.maxDatabases) ?? 5,
    maxMembers: optNumber(s.maxMembers) ?? 10,
    billingTier: BILLING_TIERS.has(s.billingTier as BillingTier)
      ? (s.billingTier as BillingTier)
      : "free",
    disabledModelIds: stringArray(s.disabledModelIds),
  };
  const autoJoin = normalizeAutoJoin(s.autoJoin);
  if (autoJoin) {
    out.autoJoin = autoJoin;
  }
  const linkPreviews = optBool(s.linkPreviews);
  if (linkPreviews !== undefined) {
    out.linkPreviews = linkPreviews;
  }
  return out;
}

export function normalizeBilling(
  raw: Record<string, unknown> | null | undefined,
): WorkspaceBilling {
  const b = raw ?? {};
  const status = b.subscriptionStatus as SubscriptionStatus | null | undefined;
  return {
    stripeCustomerId: optString(b.stripeCustomerId) ?? null,
    stripeSubscriptionId: optString(b.stripeSubscriptionId) ?? null,
    subscriptionStatus:
      status && SUBSCRIPTION_STATUSES.has(status) ? status : null,
    currentPeriodStart: nullableDate(b.currentPeriodStart),
    currentPeriodEnd: nullableDate(b.currentPeriodEnd),
    usageQuotaUsd: optNumber(b.usageQuotaUsd) ?? 5,
    // Explicit null = unlimited; missing = schema default 5.
    hardLimitUsd:
      "hardLimitUsd" in b
        ? b.hardLimitUsd === null
          ? null
          : (optNumber(b.hardLimitUsd) ?? 5)
        : 5,
    plan: BILLING_TIERS.has(b.plan as BillingPlan)
      ? (b.plan as BillingPlan)
      : "free",
    lastReportedOverageCents: optNumber(b.lastReportedOverageCents) ?? 0,
    pendingReportedOverageCents:
      optNumber(b.pendingReportedOverageCents) ?? null,
    pendingMeterEventIdempotencyKey:
      optString(b.pendingMeterEventIdempotencyKey) ?? null,
  };
}

export function normalizeRepoBinding(
  raw: unknown,
): WorkspaceRepoBinding | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== "string" || typeof r.repo !== "string") {
    return null;
  }
  const out: WorkspaceRepoBinding = {
    provider: "github",
    owner: r.owner,
    repo: r.repo,
    defaultBranch: optString(r.defaultBranch) ?? "main",
    subdirectory: optString(r.subdirectory) ?? "",
  };
  const installationId = optNumber(r.installationId);
  if (installationId !== undefined) {
    out.installationId = installationId;
  }
  const linkedBy = optString(r.linkedBy);
  if (linkedBy !== undefined) {
    out.linkedBy = linkedBy;
  }
  const linkedAt = optDate(r.linkedAt);
  if (linkedAt) {
    out.linkedAt = linkedAt;
  }
  return out;
}

/** `workspaceRepos ?? [appsRepo]`, matching the read-time migration in workspace-repos.service. */
export function normalizeRepos(
  workspaceRepos: unknown,
  appsRepo: unknown,
): WorkspaceRepoBinding[] | undefined {
  if (Array.isArray(workspaceRepos)) {
    const repos = workspaceRepos
      .map(normalizeRepoBinding)
      .filter((r): r is WorkspaceRepoBinding => r !== null);
    if (repos.length > 0 || !appsRepo) {
      return repos;
    }
  }
  const legacy = normalizeRepoBinding(appsRepo);
  if (legacy) {
    return [legacy];
  }
  return Array.isArray(workspaceRepos) ? [] : undefined;
}

export function normalizeWorkflowSlot(raw: unknown): WorkflowSlot | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: WorkflowSlot = {};
  if (typeof r.sha === "string") {
    out.sha = r.sha;
  }
  if (typeof r.tree === "string") {
    out.tree = r.tree;
  }
  const names = optStringArray(r.names);
  if (names) {
    out.names = names;
  }
  if (r.running && typeof r.running === "object") {
    const running = r.running as Record<string, unknown>;
    out.running = typeof running.sha === "string" ? { sha: running.sha } : {};
  }
  if (r.failed && typeof r.failed === "object") {
    const failed = r.failed as Record<string, unknown>;
    out.failed = {};
    if (typeof failed.sha === "string") {
      out.failed.sha = failed.sha;
    }
    if (typeof failed.error === "string") {
      out.failed.error = failed.error;
    }
  }
  return out;
}

function normalizeWebhooks(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeWorkflows(
  raw: unknown,
): WorkspaceWorkflows | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: WorkspaceWorkflows = {};
  const hatchetToken = optString(r.hatchetToken);
  if (hatchetToken !== undefined) {
    out.hatchetToken = hatchetToken;
  }
  const live = normalizeWorkflowSlot(r.live);
  if (live) {
    out.live = live;
  }
  const active = optStringArray(r.active);
  if (active) {
    out.active = active;
  }
  const webhooks = normalizeWebhooks(r.webhooks);
  if (webhooks) {
    out.webhooks = webhooks;
  }
  const lastNeededAt = optDate(r.lastNeededAt);
  if (lastNeededAt) {
    out.lastNeededAt = lastNeededAt;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mongoWorkspaceToRecord(
  doc: MongoWorkspaceLike,
): WorkspaceRecord {
  const id = toWire(doc._id);
  const createdAt = coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id));
  const record: WorkspaceRecord = {
    id,
    _id: id,
    name: doc.name ?? "",
    slug: (doc.slug ?? "").trim().toLowerCase(),
    createdBy: doc.createdBy ?? "",
    settings: normalizeSettings(doc.settings),
    billing: normalizeBilling(doc.billing),
    createdAt,
    updatedAt: coerceDate(doc.updatedAt, createdAt),
  };
  const repos = normalizeRepos(doc.workspaceRepos, doc.appsRepo);
  if (repos !== undefined) {
    record.workspaceRepos = repos;
  }
  const workflows = normalizeWorkflows(doc.workflows);
  if (workflows) {
    record.workflows = workflows;
  }
  return record;
}

export function repoToJson(r: WorkspaceRepoBinding): WorkspaceRepoBindingJson {
  return stripUndefinedDeep({
    ...r,
    linkedAt: r.linkedAt ? r.linkedAt.toISOString() : undefined,
  }) as WorkspaceRepoBindingJson;
}

export function slotToJson(slot: WorkflowSlot): WorkflowSlotJson {
  return stripUndefinedDeep(slot) as WorkflowSlotJson;
}

export function workspaceRecordToPgRow(
  record: WorkspaceRecord,
  mapUserUuid: NullableUserUuidMapper = defaultNullableUserUuid,
): NewWorkspaceRow {
  const wf = record.workflows;
  return {
    id: toPgUuid(record.id),
    name: record.name,
    slug: record.slug.trim().toLowerCase(),
    createdBy: mapUserUuid(record.createdBy),
    settingsMaxDatabases: record.settings.maxDatabases,
    settingsMaxMembers: record.settings.maxMembers,
    settingsBillingTier: record.settings.billingTier,
    settingsDisabledModelIds: record.settings.disabledModelIds,
    settingsAutoJoin: record.settings.autoJoin ?? null,
    settingsLinkPreviews: record.settings.linkPreviews ?? null,
    billingStripeCustomerId: record.billing.stripeCustomerId,
    billingStripeSubscriptionId: record.billing.stripeSubscriptionId,
    billingSubscriptionStatus: record.billing.subscriptionStatus,
    billingCurrentPeriodStart: record.billing.currentPeriodStart,
    billingCurrentPeriodEnd: record.billing.currentPeriodEnd,
    billingUsageQuotaUsd: record.billing.usageQuotaUsd,
    billingHardLimitUsd: record.billing.hardLimitUsd,
    billingPlan: record.billing.plan,
    billingLastReportedOverageCents: record.billing.lastReportedOverageCents,
    billingPendingReportedOverageCents:
      record.billing.pendingReportedOverageCents,
    billingPendingMeterEventIdempotencyKey:
      record.billing.pendingMeterEventIdempotencyKey,
    workspaceRepos: record.workspaceRepos
      ? record.workspaceRepos.map(repoToJson)
      : null,
    workflowsHatchetTokenEncrypted: wf?.hatchetToken ?? null,
    workflowsLive: wf?.live ? slotToJson(wf.live) : null,
    workflowsActive: wf?.active ?? null,
    workflowsWebhooksEncrypted: wf?.webhooks ?? null,
    workflowsLastNeededAt: wf?.lastNeededAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function pgWorkspaceToRecord(row: WorkspaceRow): WorkspaceRecord {
  const id = toWireId(row.id);
  const settings: WorkspaceSettings = {
    maxDatabases: row.settingsMaxDatabases,
    maxMembers: row.settingsMaxMembers,
    billingTier: row.settingsBillingTier,
    disabledModelIds: row.settingsDisabledModelIds ?? [],
  };
  const autoJoin = normalizeAutoJoin(row.settingsAutoJoin);
  if (autoJoin) {
    settings.autoJoin = autoJoin;
  }
  if (row.settingsLinkPreviews !== null) {
    settings.linkPreviews = row.settingsLinkPreviews;
  }
  const record: WorkspaceRecord = {
    id,
    _id: id,
    name: row.name,
    slug: row.slug,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "",
    settings,
    billing: {
      stripeCustomerId: row.billingStripeCustomerId,
      stripeSubscriptionId: row.billingStripeSubscriptionId,
      subscriptionStatus: row.billingSubscriptionStatus,
      currentPeriodStart: row.billingCurrentPeriodStart,
      currentPeriodEnd: row.billingCurrentPeriodEnd,
      usageQuotaUsd: Number(row.billingUsageQuotaUsd),
      hardLimitUsd:
        row.billingHardLimitUsd === null
          ? null
          : Number(row.billingHardLimitUsd),
      plan: row.billingPlan,
      lastReportedOverageCents: row.billingLastReportedOverageCents,
      pendingReportedOverageCents: row.billingPendingReportedOverageCents,
      pendingMeterEventIdempotencyKey:
        row.billingPendingMeterEventIdempotencyKey,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.workspaceRepos !== null && row.workspaceRepos !== undefined) {
    record.workspaceRepos = row.workspaceRepos
      .map(normalizeRepoBinding)
      .filter((r): r is WorkspaceRepoBinding => r !== null);
  }
  const anyWorkflows =
    row.workflowsHatchetTokenEncrypted !== null ||
    row.workflowsLive !== null ||
    row.workflowsActive !== null ||
    row.workflowsWebhooksEncrypted !== null ||
    row.workflowsLastNeededAt !== null;
  if (anyWorkflows) {
    record.workflows = normalizeWorkflows({
      hatchetToken: row.workflowsHatchetTokenEncrypted ?? undefined,
      live: row.workflowsLive ?? undefined,
      active: row.workflowsActive ?? undefined,
      webhooks: row.workflowsWebhooksEncrypted ?? undefined,
      lastNeededAt: row.workflowsLastNeededAt ?? undefined,
    });
  }
  return record;
}

/**
 * Full Mongo `$set` for a workspace record (Stage 4 reverse-sync / repair).
 * NEVER touches `apiKeys` (keys sync with targeted `$push/$pull/$set`), and
 * pairs with {@link workspaceRecordToMongoUnset} so absent fields are removed.
 */
export function workspaceRecordToMongoSet(
  record: WorkspaceRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  const set: Record<string, unknown> = {
    name: record.name,
    slug: record.slug,
    createdBy: record.createdBy ? mapMongoUserId(record.createdBy) : "",
    "settings.maxDatabases": record.settings.maxDatabases,
    "settings.maxMembers": record.settings.maxMembers,
    "settings.billingTier": record.settings.billingTier,
    "settings.disabledModelIds": record.settings.disabledModelIds,
    billing: { ...record.billing },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.settings.autoJoin) {
    set["settings.autoJoin"] = record.settings.autoJoin;
  }
  if (record.settings.linkPreviews !== undefined) {
    set["settings.linkPreviews"] = record.settings.linkPreviews;
  }
  if (record.workspaceRepos) {
    set.workspaceRepos = record.workspaceRepos;
  }
  if (record.workflows) {
    set.workflows = stripUndefinedDeep(record.workflows);
  }
  return set;
}

export function workspaceRecordToMongoUnset(
  record: WorkspaceRecord,
): Record<string, ""> {
  const unset: Record<string, ""> = { appsRepo: "" };
  if (!record.settings.autoJoin) {
    unset["settings.autoJoin"] = "";
  }
  if (record.settings.linkPreviews === undefined) {
    unset["settings.linkPreviews"] = "";
  }
  if (!record.workspaceRepos) {
    unset.workspaceRepos = "";
  }
  if (!record.workflows) {
    unset.workflows = "";
  }
  return unset;
}

// ── 2. workspace_api_keys ────────────────────────────────────────────────

export interface MongoApiKeyLike {
  _id?: IdLike;
  name?: string;
  keyHash?: string;
  prefix?: string;
  scopes?: string[] | null;
  createdAt?: Date | string;
  lastUsedAt?: Date | string | null;
  createdBy?: string;
  agentRun?: boolean | null;
  recordWrites?: boolean | null;
}

export function mongoApiKeyToRecord(
  workspaceId: IdLike,
  key: MongoApiKeyLike,
): WorkspaceApiKeyRecord {
  const wsWire = toWire(workspaceId);
  const keyHash = key.keyHash ?? "";
  const id =
    key._id != null ? toWire(key._id) : fallbackApiKeyId(wsWire, keyHash);
  const record: WorkspaceApiKeyRecord = {
    id,
    _id: id,
    workspaceId: wsWire,
    name: key.name ?? "",
    keyHash,
    prefix: key.prefix ?? "",
    createdBy: key.createdBy ?? "",
    createdAt: coerceDate(key.createdAt, deriveCreatedAtFromWireId(id)),
  };
  if (Array.isArray(key.scopes)) {
    record.scopes = stringArray(key.scopes) as WorkspaceApiKeyScope[];
  }
  const agentRun = optBool(key.agentRun);
  if (agentRun !== undefined) {
    record.agentRun = agentRun;
  }
  const recordWrites = optBool(key.recordWrites);
  if (recordWrites !== undefined) {
    record.recordWrites = recordWrites;
  }
  const lastUsedAt = optDate(key.lastUsedAt);
  if (lastUsedAt) {
    record.lastUsedAt = lastUsedAt;
  }
  return record;
}

export function apiKeyRecordToPgRow(
  record: WorkspaceApiKeyRecord,
  mapUserUuid: NullableUserUuidMapper = defaultNullableUserUuid,
): NewWorkspaceApiKeyRow {
  return {
    id: toPgUuid(record.id),
    workspaceId: toPgUuid(record.workspaceId),
    name: record.name,
    keyHash: record.keyHash,
    prefix: record.prefix,
    scopes: record.scopes ?? null,
    createdBy: mapUserUuid(record.createdBy),
    agentRun: record.agentRun ?? null,
    recordWrites: record.recordWrites ?? null,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
  };
}

export function pgApiKeyToRecord(
  row: WorkspaceApiKeyRow,
): WorkspaceApiKeyRecord {
  const id = toWireId(row.id);
  const record: WorkspaceApiKeyRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    keyHash: row.keyHash,
    prefix: row.prefix,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "",
    createdAt: row.createdAt,
  };
  if (row.scopes !== null) {
    record.scopes = row.scopes as WorkspaceApiKeyScope[];
  }
  if (row.agentRun !== null) {
    record.agentRun = row.agentRun;
  }
  if (row.recordWrites !== null) {
    record.recordWrites = row.recordWrites;
  }
  if (row.lastUsedAt !== null) {
    record.lastUsedAt = row.lastUsedAt;
  }
  return record;
}

/** `apiKeys[]` subdocument for a Mongo `$push` (never includes `workspaceId`). */
export function apiKeyRecordToMongoSubdoc(
  record: WorkspaceApiKeyRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: record.id,
    name: record.name,
    keyHash: record.keyHash,
    prefix: record.prefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    createdBy: record.createdBy ? mapMongoUserId(record.createdBy) : "",
    agentRun: record.agentRun,
    recordWrites: record.recordWrites,
  }) as Record<string, unknown>;
}

// ── 3. workspace_members ─────────────────────────────────────────────────

export interface MongoMemberLike {
  _id: IdLike;
  workspaceId: IdLike;
  userId: string | { _id?: unknown } | null | undefined;
  role?: string;
  joinedAt?: Date | string;
  isDefaultMembership?: boolean | null;
}

const MEMBER_ROLES = new Set<WorkspaceMemberRole>([
  "owner",
  "admin",
  "member",
  "viewer",
]);

function userIdOf(value: MongoMemberLike["userId"]): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && value._id != null) {
    return String(value._id);
  }
  return "";
}

export function mongoMemberToRecord(
  doc: MongoMemberLike,
): WorkspaceMemberRecord {
  const id = toWire(doc._id);
  const record: WorkspaceMemberRecord = {
    id,
    _id: id,
    workspaceId: toWire(doc.workspaceId),
    userId: userIdOf(doc.userId),
    role: MEMBER_ROLES.has(doc.role as WorkspaceMemberRole)
      ? (doc.role as WorkspaceMemberRole)
      : "member",
    joinedAt: coerceDate(doc.joinedAt, deriveCreatedAtFromWireId(id)),
  };
  const isDefault = optBool(doc.isDefaultMembership);
  if (isDefault !== undefined) {
    record.isDefaultMembership = isDefault;
  }
  return record;
}

export function memberRecordToPgRow(
  record: WorkspaceMemberRecord,
  mapUserUuid: RequiredUserUuidMapper = defaultRequiredUserUuid,
  updatedAt: Date = record.joinedAt,
): NewWorkspaceMemberRow {
  return {
    id: toPgUuid(record.id),
    workspaceId: toPgUuid(record.workspaceId),
    userId: mapUserUuid(record.userId),
    role: record.role,
    joinedAt: record.joinedAt,
    isDefaultMembership: record.isDefaultMembership ?? null,
    updatedAt,
  };
}

export function pgMemberToRecord(
  row: WorkspaceMemberRow,
): WorkspaceMemberRecord {
  const id = toWireId(row.id);
  const record: WorkspaceMemberRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId.toLowerCase(),
    role: row.role,
    joinedAt: row.joinedAt,
  };
  if (row.isDefaultMembership !== null) {
    record.isDefaultMembership = row.isDefaultMembership;
  }
  return record;
}

export function memberRecordToMongoDoc(
  record: WorkspaceMemberRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: record.id,
    workspaceId: record.workspaceId,
    userId: mapMongoUserId(record.userId),
    role: record.role,
    joinedAt: record.joinedAt,
    isDefaultMembership: record.isDefaultMembership,
  }) as Record<string, unknown>;
}

// ── 4. workspace_invites ─────────────────────────────────────────────────

export interface MongoInviteLike {
  _id: IdLike;
  workspaceId: IdLike | { _id?: unknown };
  email?: string;
  token?: string;
  role?: string;
  invitedBy?: string | { _id?: unknown } | null;
  expiresAt?: Date | string;
  acceptedAt?: Date | string | null;
  createdAt?: Date | string;
}

const INVITE_ROLES = new Set<WorkspaceInviteRole>([
  "admin",
  "member",
  "viewer",
]);

function refIdOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const v = value as { _id?: unknown; toHexString?: () => string };
    if (typeof v.toHexString === "function") {
      return v.toHexString();
    }
    if (v._id != null) {
      return String(v._id);
    }
    return String(value);
  }
  return "";
}

export function mongoInviteToRecord(
  doc: MongoInviteLike,
): WorkspaceInviteRecord {
  const id = toWire(doc._id);
  const record: WorkspaceInviteRecord = {
    id,
    _id: id,
    workspaceId: toWire(refIdOf(doc.workspaceId)),
    email: (doc.email ?? "").trim().toLowerCase(),
    token: doc.token ?? "",
    role: INVITE_ROLES.has(doc.role as WorkspaceInviteRole)
      ? (doc.role as WorkspaceInviteRole)
      : "member",
    invitedBy: refIdOf(doc.invitedBy),
    expiresAt: coerceDate(doc.expiresAt),
    createdAt: coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id)),
  };
  const acceptedAt = optDate(doc.acceptedAt);
  if (acceptedAt) {
    record.acceptedAt = acceptedAt;
  }
  return record;
}

export function inviteRecordToPgRow(
  record: WorkspaceInviteRecord,
  mapUserUuid: NullableUserUuidMapper = defaultNullableUserUuid,
  updatedAt: Date = record.acceptedAt ?? record.createdAt,
): NewWorkspaceInviteRow {
  return {
    id: toPgUuid(record.id),
    workspaceId: toPgUuid(record.workspaceId),
    email: record.email.trim().toLowerCase(),
    token: record.token,
    role: record.role,
    invitedBy: mapUserUuid(record.invitedBy),
    expiresAt: record.expiresAt,
    acceptedAt: record.acceptedAt ?? null,
    createdAt: record.createdAt,
    updatedAt,
  };
}

export function pgInviteToRecord(
  row: WorkspaceInviteRow,
): WorkspaceInviteRecord {
  const id = toWireId(row.id);
  const record: WorkspaceInviteRecord = {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    email: row.email,
    token: row.token,
    role: row.role,
    invitedBy: row.invitedBy ? row.invitedBy.toLowerCase() : "",
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.acceptedAt !== null) {
    record.acceptedAt = row.acceptedAt;
  }
  return record;
}

export function inviteRecordToMongoDoc(
  record: WorkspaceInviteRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: record.id,
    workspaceId: record.workspaceId,
    email: record.email,
    token: record.token,
    role: record.role,
    invitedBy: record.invitedBy ? mapMongoUserId(record.invitedBy) : "",
    expiresAt: record.expiresAt,
    acceptedAt: record.acceptedAt,
  }) as Record<string, unknown>;
}

// ── 5. workspace_user_handles ────────────────────────────────────────────

export interface MongoHandleLike {
  _id: IdLike;
  workspaceId: IdLike;
  userId?: string | null;
  handle?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoHandleToRecord(
  doc: MongoHandleLike,
): WorkspaceUserHandleRecord {
  const id = toWire(doc._id);
  const createdAt = coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id));
  return {
    id,
    _id: id,
    workspaceId: toWire(doc.workspaceId),
    userId: doc.userId ?? "",
    handle: doc.handle ?? "",
    createdAt,
    updatedAt: coerceDate(doc.updatedAt, createdAt),
  };
}

export function handleRecordToPgRow(
  record: WorkspaceUserHandleRecord,
  mapUserUuid: NullableUserUuidMapper = defaultNullableUserUuid,
): NewWorkspaceUserHandleRow {
  return {
    id: toPgUuid(record.id),
    workspaceId: toPgUuid(record.workspaceId),
    userId: mapUserUuid(record.userId),
    handle: record.handle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function pgHandleToRecord(
  row: WorkspaceUserHandleRow,
): WorkspaceUserHandleRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId ? row.userId.toLowerCase() : "",
    handle: row.handle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function handleRecordToMongoDoc(
  record: WorkspaceUserHandleRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return {
    _id: record.id,
    workspaceId: record.workspaceId,
    userId: record.userId ? mapMongoUserId(record.userId) : "",
    handle: record.handle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ── 6. mcp_oauth_clients ─────────────────────────────────────────────────

export interface MongoMcpClientLike {
  _id: IdLike;
  clientId?: string;
  clientName?: string | null;
  redirectUris?: string[];
  createdAt?: Date | string;
}

export function mongoMcpClientToRecord(
  doc: MongoMcpClientLike,
): McpOAuthClientRecord {
  const id = toWire(doc._id);
  const record: McpOAuthClientRecord = {
    id,
    _id: id,
    clientId: doc.clientId ?? "",
    redirectUris: stringArray(doc.redirectUris),
    createdAt: coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id)),
  };
  const clientName = optString(doc.clientName);
  if (clientName !== undefined) {
    record.clientName = clientName;
  }
  return record;
}

export function mcpClientRecordToPgRow(
  r: McpOAuthClientRecord,
): NewMcpOAuthClientRow {
  return {
    id: toPgUuid(r.id),
    clientId: r.clientId,
    clientName: r.clientName ?? null,
    redirectUris: r.redirectUris,
    createdAt: r.createdAt,
  };
}

export function pgMcpClientToRecord(
  row: McpOAuthClientRow,
): McpOAuthClientRecord {
  const id = toWireId(row.id);
  const record: McpOAuthClientRecord = {
    id,
    _id: id,
    clientId: row.clientId,
    redirectUris: row.redirectUris,
    createdAt: row.createdAt,
  };
  if (row.clientName !== null) {
    record.clientName = row.clientName;
  }
  return record;
}

export function mcpClientRecordToMongoDoc(
  r: McpOAuthClientRecord,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    redirectUris: r.redirectUris,
    createdAt: r.createdAt,
  }) as Record<string, unknown>;
}

// ── 7. mcp_oauth_codes ───────────────────────────────────────────────────

export interface MongoMcpCodeLike {
  _id: IdLike;
  codeHash?: string;
  clientId?: string;
  userId?: string;
  workspaceId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  scopes?: string[];
  expiresAt?: Date | string;
  usedAt?: Date | string | null;
}

/**
 * Normalize valid entity IDs (24-hex ObjectId or 36-char UUID) to wire form,
 * preserving arbitrary strings verbatim for Mongo string-typed `workspaceId`
 * fields (`mcp_oauth_codes`, `mcp_oauth_tokens`, `acp_plan_grants`). PG row
 * mappers still strictly enforce `toPgUuid(...)` and backfill quarantines
 * non-entity values.
 */
export function toWireOrRaw(value: unknown): string {
  const s =
    typeof value === "string" ? value : value == null ? "" : String(value);
  if (!s) {
    return "";
  }
  const parsed = parseEntityId(s);
  return parsed ? (parsed.oid ?? parsed.uuid) : s;
}

export function mongoMcpCodeToRecord(
  doc: MongoMcpCodeLike,
): McpOAuthCodeRecord {
  const id = toWire(doc._id);
  const record: McpOAuthCodeRecord = {
    id,
    _id: id,
    codeHash: doc.codeHash ?? "",
    clientId: doc.clientId ?? "",
    userId: doc.userId ?? "",
    workspaceId: toWireOrRaw(doc.workspaceId),
    redirectUri: doc.redirectUri ?? "",
    codeChallenge: doc.codeChallenge ?? "",
    scopes: stringArray(doc.scopes),
    expiresAt: coerceDate(doc.expiresAt),
  };
  const usedAt = optDate(doc.usedAt);
  if (usedAt) {
    record.usedAt = usedAt;
  }
  return record;
}

export function mcpCodeRecordToPgRow(
  r: McpOAuthCodeRecord,
  mapUserUuid: RequiredUserUuidMapper = defaultRequiredUserUuid,
): NewMcpOAuthCodeRow {
  return {
    id: toPgUuid(r.id),
    codeHash: r.codeHash,
    clientId: r.clientId,
    userId: mapUserUuid(r.userId),
    workspaceId: toPgUuid(r.workspaceId),
    redirectUri: r.redirectUri,
    codeChallenge: r.codeChallenge,
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt ?? null,
  };
}

export function pgMcpCodeToRecord(row: McpOAuthCodeRow): McpOAuthCodeRecord {
  const id = toWireId(row.id);
  const record: McpOAuthCodeRecord = {
    id,
    _id: id,
    codeHash: row.codeHash,
    clientId: row.clientId,
    userId: row.userId.toLowerCase(),
    workspaceId: toWireId(row.workspaceId),
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
  };
  if (row.usedAt !== null) {
    record.usedAt = row.usedAt;
  }
  return record;
}

export function mcpCodeRecordToMongoDoc(
  r: McpOAuthCodeRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: r.id,
    codeHash: r.codeHash,
    clientId: r.clientId,
    userId: mapMongoUserId(r.userId),
    workspaceId: r.workspaceId,
    redirectUri: r.redirectUri,
    codeChallenge: r.codeChallenge,
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
  }) as Record<string, unknown>;
}

// ── 8. mcp_oauth_tokens ──────────────────────────────────────────────────

export interface MongoMcpTokenLike {
  _id: IdLike;
  accessTokenHash?: string;
  refreshTokenHash?: string;
  clientId?: string;
  userId?: string;
  workspaceId?: string;
  agentSessionId?: string | null;
  scopes?: string[];
  accessExpiresAt?: Date | string;
  refreshExpiresAt?: Date | string | null;
  createdAt?: Date | string;
  lastUsedAt?: Date | string | null;
}

export function mongoMcpTokenToRecord(
  doc: MongoMcpTokenLike,
): McpOAuthTokenRecord {
  const id = toWire(doc._id);
  const record: McpOAuthTokenRecord = {
    id,
    _id: id,
    accessTokenHash: doc.accessTokenHash ?? "",
    refreshTokenHash: doc.refreshTokenHash ?? "",
    clientId: doc.clientId ?? "",
    userId: doc.userId ?? "",
    workspaceId: toWireOrRaw(doc.workspaceId),
    scopes: stringArray(doc.scopes),
    accessExpiresAt: coerceDate(doc.accessExpiresAt),
    createdAt: coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id)),
  };
  const agentSessionId = optString(doc.agentSessionId);
  if (agentSessionId !== undefined) {
    record.agentSessionId = agentSessionId;
  }
  const refreshExpiresAt = optDate(doc.refreshExpiresAt);
  if (refreshExpiresAt) {
    record.refreshExpiresAt = refreshExpiresAt;
  }
  const lastUsedAt = optDate(doc.lastUsedAt);
  if (lastUsedAt) {
    record.lastUsedAt = lastUsedAt;
  }
  return record;
}

export function mcpTokenRecordToPgRow(
  r: McpOAuthTokenRecord,
  mapUserUuid: RequiredUserUuidMapper = defaultRequiredUserUuid,
  updatedAt: Date = r.lastUsedAt ?? r.createdAt,
): NewMcpOAuthTokenRow {
  return {
    id: toPgUuid(r.id),
    accessTokenHash: r.accessTokenHash,
    refreshTokenHash: r.refreshTokenHash,
    clientId: r.clientId,
    userId: mapUserUuid(r.userId),
    workspaceId: toPgUuid(r.workspaceId),
    agentSessionId: r.agentSessionId ?? null,
    scopes: r.scopes,
    accessExpiresAt: r.accessExpiresAt,
    refreshExpiresAt: r.refreshExpiresAt ?? null,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
    updatedAt,
  };
}

export function pgMcpTokenToRecord(row: McpOAuthTokenRow): McpOAuthTokenRecord {
  const id = toWireId(row.id);
  const record: McpOAuthTokenRecord = {
    id,
    _id: id,
    accessTokenHash: row.accessTokenHash,
    refreshTokenHash: row.refreshTokenHash,
    clientId: row.clientId,
    userId: row.userId.toLowerCase(),
    workspaceId: toWireId(row.workspaceId),
    scopes: row.scopes,
    accessExpiresAt: row.accessExpiresAt,
    createdAt: row.createdAt,
  };
  if (row.agentSessionId !== null) {
    record.agentSessionId = row.agentSessionId;
  }
  if (row.refreshExpiresAt !== null) {
    record.refreshExpiresAt = row.refreshExpiresAt;
  }
  if (row.lastUsedAt !== null) {
    record.lastUsedAt = row.lastUsedAt;
  }
  return record;
}

export function mcpTokenRecordToMongoDoc(
  r: McpOAuthTokenRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return stripUndefinedDeep({
    _id: r.id,
    accessTokenHash: r.accessTokenHash,
    refreshTokenHash: r.refreshTokenHash,
    clientId: r.clientId,
    userId: mapMongoUserId(r.userId),
    workspaceId: r.workspaceId,
    agentSessionId: r.agentSessionId,
    scopes: r.scopes,
    accessExpiresAt: r.accessExpiresAt,
    refreshExpiresAt: r.refreshExpiresAt,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }) as Record<string, unknown>;
}

// ── 9. acp_plan_grants ───────────────────────────────────────────────────

export interface MongoAcpGrantLike {
  _id: IdLike;
  workspaceId?: string;
  userId?: string;
  agentSessionId?: string;
  planDigest?: string;
  grants?: string[];
  status?: string;
  expiresAt?: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoAcpGrantToRecord(
  doc: MongoAcpGrantLike,
): AcpPlanGrantRecord {
  const id = toWire(doc._id);
  const createdAt = coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id));
  return {
    id,
    _id: id,
    workspaceId: toWireOrRaw(doc.workspaceId),
    userId: doc.userId ?? "",
    agentSessionId: doc.agentSessionId ?? "",
    planDigest: doc.planDigest ?? "",
    grants: stringArray(doc.grants),
    status: doc.status === "revoked" ? "revoked" : "approved",
    expiresAt: coerceDate(doc.expiresAt),
    createdAt,
    updatedAt: coerceDate(doc.updatedAt, createdAt),
  };
}

export function acpGrantRecordToPgRow(
  r: AcpPlanGrantRecord,
  mapUserUuid: RequiredUserUuidMapper = defaultRequiredUserUuid,
): NewAcpPlanGrantRow {
  return {
    id: toPgUuid(r.id),
    workspaceId: toPgUuid(r.workspaceId),
    userId: mapUserUuid(r.userId),
    agentSessionId: r.agentSessionId,
    planDigest: r.planDigest,
    grants: r.grants,
    status: r.status,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function pgAcpGrantToRecord(row: AcpPlanGrantRow): AcpPlanGrantRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId.toLowerCase(),
    agentSessionId: row.agentSessionId,
    planDigest: row.planDigest,
    grants: row.grants,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function acpGrantRecordToMongoDoc(
  r: AcpPlanGrantRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return {
    _id: r.id,
    workspaceId: r.workspaceId,
    userId: mapMongoUserId(r.userId),
    agentSessionId: r.agentSessionId,
    planDigest: r.planDigest,
    grants: r.grants,
    status: r.status,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── 10. github_installations ─────────────────────────────────────────────

export interface MongoGitHubInstallationLike {
  _id: IdLike;
  workspaceId: IdLike;
  installationId?: number;
  accountLogin?: string;
  accountType?: string;
  repositorySelection?: string;
  createdBy?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

const GITHUB_ACCOUNT_TYPES = new Set<GitHubAccountType>([
  "Organization",
  "User",
]);
const GITHUB_REPO_SELECTIONS = new Set<GitHubRepoSelection>([
  "all",
  "selected",
]);

export function mongoGitHubInstallationToRecord(
  doc: MongoGitHubInstallationLike,
): GitHubInstallationRecord {
  const id = toWire(doc._id);
  const createdAt = coerceDate(doc.createdAt, deriveCreatedAtFromWireId(id));
  return {
    id,
    _id: id,
    workspaceId: toWire(doc.workspaceId),
    installationId: Number(doc.installationId ?? 0),
    accountLogin: (doc.accountLogin ?? "").trim(),
    accountType: GITHUB_ACCOUNT_TYPES.has(doc.accountType as GitHubAccountType)
      ? (doc.accountType as GitHubAccountType)
      : "Organization",
    repositorySelection: GITHUB_REPO_SELECTIONS.has(
      doc.repositorySelection as GitHubRepoSelection,
    )
      ? (doc.repositorySelection as GitHubRepoSelection)
      : "all",
    createdBy: doc.createdBy ?? "",
    createdAt,
    updatedAt: coerceDate(doc.updatedAt, createdAt),
  };
}

export function githubInstallationRecordToPgRow(
  r: GitHubInstallationRecord,
  mapUserUuid: NullableUserUuidMapper = defaultNullableUserUuid,
): NewGitHubInstallationRow {
  return {
    id: toPgUuid(r.id),
    workspaceId: toPgUuid(r.workspaceId),
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    repositorySelection: r.repositorySelection,
    createdBy: mapUserUuid(r.createdBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function pgGitHubInstallationToRecord(
  row: GitHubInstallationRow,
): GitHubInstallationRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    installationId: Number(row.installationId),
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function githubInstallationRecordToMongoDoc(
  r: GitHubInstallationRecord,
  mapMongoUserId: MongoUserIdMapper = identityUserId,
): Record<string, unknown> {
  return {
    _id: r.id,
    workspaceId: r.workspaceId,
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    repositorySelection: r.repositorySelection,
    createdBy: r.createdBy ? mapMongoUserId(r.createdBy) : "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── canonicalization helpers for shadow-compare / verifier ───────────────

export function sortById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}
