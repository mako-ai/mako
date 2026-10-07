/**
 * Hatchet access for workspace workflows (rfcs/workflows-as-code.md).
 *
 * One Hatchet tenant per workspace. Mako stores the tenant id and an encrypted
 * tenant token on `Workspace.workflows`, and nothing else: registered
 * workflows, crons, runs, tasks and logs are read from Hatchet on demand, in
 * Hatchet's own response shapes.
 *
 * Two credentials, two jobs:
 *   - the admin login (HATCHET_ADMIN_PASSWORD) creates a tenant and its token,
 *     once per workspace
 *   - the tenant token makes every other call, so Hatchet itself keeps one
 *     workspace from reading another's runs
 *
 * Reaching Hatchet: HATCHET_API_URL when set (local Hatchet Lite), otherwise
 * the `hatchet-api` pod's IP on the notebook-kernels cluster over the VPC —
 * the same path the API uses for kernel gateways.
 */
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { decryptString, encryptString } from "../services/crypto.service";
import {
  gkeClients,
  isGkeProviderConfigured,
} from "../services/kernel-provider/gke-kernel-provider";

const logger = loggers.api("workflows-hatchet");

const HATCHET_NAMESPACE = process.env.HATCHET_NAMESPACE || "hatchet";
const HATCHET_API_POD_LABEL =
  "app.kubernetes.io/instance=hatchet,app.kubernetes.io/name=api";
const HATCHET_API_PORT = process.env.HATCHET_API_PORT || "8080";
const ADMIN_EMAIL =
  process.env.HATCHET_ADMIN_EMAIL || "workflows-admin@mako.ai";
// Tenant tokens are long-lived: the worker Secret holds the same token, and
// rotating it means rewriting that Secret.
const TOKEN_TTL = "87600h";
const REQUEST_TIMEOUT_MS = 20_000;
const POD_IP_TTL_MS = 60_000;

/**
 * Prefix for tenant slugs and worker names. PR previews share one Hatchet and
 * one cluster, so each sets `pr-<n>-` to stay out of the others' way.
 */
export function workflowsNamePrefix(): string {
  return process.env.WORKFLOWS_NAME_PREFIX || "";
}

/** True when this API instance can create tenants and read Hatchet. */
export function isHatchetConfigured(): boolean {
  return (
    Boolean(process.env.HATCHET_ADMIN_PASSWORD) &&
    (Boolean(process.env.HATCHET_API_URL) || isGkeProviderConfigured())
  );
}

export class HatchetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HatchetError";
  }
}

let cachedPodUrl: { url: string; at: number } | null = null;

async function baseUrl(): Promise<string> {
  const fixed = process.env.HATCHET_API_URL;
  if (fixed) return fixed.replace(/\/+$/, "");
  if (cachedPodUrl && Date.now() - cachedPodUrl.at < POD_IP_TTL_MS) {
    return cachedPodUrl.url;
  }
  const { core } = await gkeClients();
  const list = await core.listNamespacedPod({
    namespace: HATCHET_NAMESPACE,
    labelSelector: HATCHET_API_POD_LABEL,
  });
  const pod = (list.items ?? []).find(
    p =>
      !p.metadata?.deletionTimestamp &&
      p.status?.podIP &&
      p.status.conditions?.some(c => c.type === "Ready" && c.status === "True"),
  );
  const podIp = pod?.status?.podIP;
  if (!podIp) throw new HatchetError("No ready Hatchet API pod", 503);
  cachedPodUrl = { url: `http://${podIp}:${HATCHET_API_PORT}`, at: Date.now() };
  return cachedPodUrl.url;
}

export interface HatchetRequest {
  method?: "GET" | "POST";
  query?: URLSearchParams;
  body?: unknown;
}

async function send(
  path: string,
  headers: Record<string, string>,
  req: HatchetRequest,
): Promise<Response> {
  const query = req.query?.toString();
  const url = `${await baseUrl()}${path}${query ? `?${query}` : ""}`;
  try {
    return await fetch(url, {
      method: req.method ?? "GET",
      headers: {
        ...headers,
        ...(req.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A cached pod IP goes stale when Hatchet restarts; resolve again next time.
    cachedPodUrl = null;
    throw new HatchetError(
      `Hatchet is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
}

async function parse<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HatchetError(
      `${what} failed (${res.status}): ${text.slice(0, 500)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// --- Admin: tenant and token creation --------------------------------------

async function adminCookie(): Promise<string> {
  const res = await send(
    "/api/v1/users/login",
    {},
    {
      method: "POST",
      body: {
        email: ADMIN_EMAIL,
        password: process.env.HATCHET_ADMIN_PASSWORD,
      },
    },
  );
  if (!res.ok) {
    throw new HatchetError(`Hatchet admin login failed (${res.status})`, 502);
  }
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new HatchetError("Hatchet login set no cookie", 502);
  return cookie;
}

interface TenantMembership {
  tenant?: { slug?: string; metadata?: { id?: string } };
}

/** The tenant for this slug: created now, or found if an earlier call made it. */
async function ensureTenant(cookie: string, slug: string): Promise<string> {
  const created = await send(
    "/api/v1/tenants",
    { Cookie: cookie },
    { method: "POST", body: { name: slug, slug } },
  );
  if (created.ok) {
    const tenant = (await created.json()) as { metadata?: { id?: string } };
    if (tenant.metadata?.id) return tenant.metadata.id;
  }
  const memberships = await parse<{ rows?: TenantMembership[] }>(
    await send("/api/v1/users/memberships", { Cookie: cookie }, {}),
    "List Hatchet tenants",
  );
  const existing = memberships.rows?.find(m => m.tenant?.slug === slug);
  const id = existing?.tenant?.metadata?.id;
  if (!id) {
    throw new HatchetError(
      `Could not create Hatchet tenant ${slug} (${created.status})`,
      502,
    );
  }
  return id;
}

export interface WorkspaceTenant {
  tenantId: string;
  token: string;
}

const tenantInFlight = new Map<string, Promise<WorkspaceTenant>>();

/**
 * The workspace's tenant and token, created on first use and saved on the
 * workspace. Concurrent first calls share one creation.
 */
export function ensureWorkspaceTenant(
  workspaceId: string,
): Promise<WorkspaceTenant> {
  const running = tenantInFlight.get(workspaceId);
  if (running) return running;
  const run = ensureWorkspaceTenantNow(workspaceId).finally(() => {
    tenantInFlight.delete(workspaceId);
  });
  tenantInFlight.set(workspaceId, run);
  return run;
}

async function ensureWorkspaceTenantNow(
  workspaceId: string,
): Promise<WorkspaceTenant> {
  const existing = await readWorkspaceTenant(workspaceId);
  if (existing) return existing;

  const slug = `${workflowsNamePrefix()}${workspaceId}`;
  const cookie = await adminCookie();
  const tenantId = await ensureTenant(cookie, slug);
  const { token } = await parse<{ token: string }>(
    await send(
      `/api/v1/tenants/${tenantId}/api-tokens`,
      { Cookie: cookie },
      { method: "POST", body: { name: "mako", expiresIn: TOKEN_TTL } },
    ),
    "Create Hatchet token",
  );
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    {
      $set: {
        "workflows.hatchetTenantId": tenantId,
        "workflows.hatchetToken": encryptString(token),
      },
    },
  );
  logger.info("Created Hatchet tenant", { workspaceId, tenantId });
  return { tenantId, token };
}

/** The saved tenant and token, or null when the workspace has none yet. */
export async function readWorkspaceTenant(
  workspaceId: string,
): Promise<WorkspaceTenant | null> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows")
    .lean();
  const tenantId = workspace?.workflows?.hatchetTenantId;
  const encrypted = workspace?.workflows?.hatchetToken;
  if (!tenantId || !encrypted) return null;
  return { tenantId, token: decryptString(encrypted) };
}

// --- Tenant calls -----------------------------------------------------------

/** One call to Hatchet as the workspace's tenant. Returns Hatchet's response. */
export function tenantFetch(
  tenant: WorkspaceTenant,
  path: string,
  req: HatchetRequest = {},
): Promise<Response> {
  return send(path, { Authorization: `Bearer ${tenant.token}` }, req);
}

export async function tenantJson<T>(
  tenant: WorkspaceTenant,
  path: string,
  req: HatchetRequest = {},
): Promise<T> {
  return parse<T>(await tenantFetch(tenant, path, req), `Hatchet ${path}`);
}

const UUID = "[0-9a-fA-F-]{36}";

/**
 * The Hatchet reads the UI may make, keyed by the path under
 * `/workflows/hatchet/`. `{tenant}` is filled in server-side; every other
 * Hatchet route is unreachable through Mako. Run and task routes carry no
 * tenant in their path — Hatchet checks the token against the resource.
 */
const READ_ALLOWLIST: Array<{ pattern: RegExp; target: string }> = [
  {
    pattern: /^runs$/,
    target: "/api/v1/stable/tenants/{tenant}/workflow-runs",
  },
  {
    pattern: new RegExp(`^runs/(${UUID})$`),
    target: "/api/v1/stable/workflow-runs/$1",
  },
  {
    pattern: new RegExp(`^runs/(${UUID})/task-events$`),
    target: "/api/v1/stable/workflow-runs/$1/task-events",
  },
  {
    pattern: new RegExp(`^tasks/(${UUID})$`),
    target: "/api/v1/stable/tasks/$1",
  },
  {
    pattern: new RegExp(`^tasks/(${UUID})/logs$`),
    target: "/api/v1/stable/tasks/$1/logs",
  },
  { pattern: /^workers$/, target: "/api/v1/tenants/{tenant}/worker" },
  { pattern: /^workflows$/, target: "/api/v1/tenants/{tenant}/workflows" },
  { pattern: /^crons$/, target: "/api/v1/tenants/{tenant}/workflows/crons" },
];

/** The Hatchet path for an allowlisted read, or null when it is not allowed. */
export function resolveHatchetRead(
  subPath: string,
  tenantId: string,
): string | null {
  for (const { pattern, target } of READ_ALLOWLIST) {
    const match = pattern.exec(subPath);
    if (!match) continue;
    return target.replace("{tenant}", tenantId).replace("$1", match[1] ?? "");
  }
  return null;
}

export function isHatchetId(value: string): boolean {
  return new RegExp(`^${UUID}$`).test(value);
}

export function triggerRun(
  tenant: WorkspaceTenant,
  workflowName: string,
  input: object,
  additionalMetadata: Record<string, string>,
): Promise<unknown> {
  return tenantJson(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/workflow-runs/trigger`,
    { method: "POST", body: { workflowName, input, additionalMetadata } },
  );
}

export function cancelRun(
  tenant: WorkspaceTenant,
  runId: string,
): Promise<unknown> {
  return tenantJson(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/tasks/cancel`,
    { method: "POST", body: { externalIds: [runId] } },
  );
}

export function replayRun(
  tenant: WorkspaceTenant,
  runId: string,
): Promise<unknown> {
  return tenantJson(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/tasks/replay`,
    { method: "POST", body: { externalIds: [runId] } },
  );
}
