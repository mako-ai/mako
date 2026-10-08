/**
 * Hatchet access for workspace workflows (docs/src/content/docs/workflows.md).
 *
 * A workspace's connection to Hatchet is one API token. The token is a JWT
 * that names its tenant and the Hatchet API's address, so nothing else is
 * configured or stored. It works the same against Hatchet Cloud, a
 * self-hosted Hatchet and the Hatchet Lite in docker-compose, and Hatchet
 * itself keeps one tenant's token from reading another tenant.
 *
 * Where the token comes from:
 *   - HATCHET_CLIENT_TOKEN: one tenant for the whole installation, or
 *   - created by Mako when HATCHET_ADMIN_PASSWORD is set: Mako logs in to a
 *     Hatchet it operates, creates a tenant for the workspace and saves its
 *     token on the workspace (Mako's own cloud, and the local docker-compose
 *     setup). A saved token wins over the installation's.
 *
 * Mako stores no workflow state: registered workflows, crons, runs, tasks and
 * logs are read from Hatchet on demand, in Hatchet's own response shapes.
 */
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { decryptString, encryptString } from "../services/crypto.service";

const logger = loggers.api("workflows-hatchet");

const ADMIN_EMAIL =
  process.env.HATCHET_ADMIN_EMAIL || "workflows-admin@mako.ai";
// Tokens Mako creates are long-lived: rotating one means re-saving it.
const TOKEN_TTL = "87600h";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Prefix for the tenants Mako creates and for worker names. PR previews share
 * one Hatchet and one cluster, so each sets `pr-<n>-`.
 */
export function workflowsNamePrefix(): string {
  return process.env.WORKFLOWS_NAME_PREFIX || "";
}

/** True when a workspace without its own token can still get one. */
export function hasInstanceHatchet(): boolean {
  return Boolean(
    process.env.HATCHET_CLIENT_TOKEN ||
      (process.env.HATCHET_ADMIN_PASSWORD && process.env.HATCHET_API_URL),
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

export interface WorkspaceTenant {
  tenantId: string;
  token: string;
  /** Base URL of the Hatchet REST API. */
  apiUrl: string;
}

/**
 * Read a Hatchet token's tenant and API address. HATCHET_API_URL overrides
 * the address in the token, for a Hatchet whose advertised URL the Mako API
 * cannot resolve (an in-cluster name, or `localhost` seen from a container).
 */
export function tenantFromToken(token: string): WorkspaceTenant {
  let claims: { sub?: string; server_url?: string };
  try {
    claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
  } catch {
    throw new HatchetError("The Hatchet token is not a valid token", 400);
  }
  const apiUrl = process.env.HATCHET_API_URL || claims.server_url;
  if (!claims.sub || !apiUrl) {
    throw new HatchetError(
      "The Hatchet token names no tenant or API address",
      400,
    );
  }
  return { tenantId: claims.sub, token, apiUrl: apiUrl.replace(/\/+$/, "") };
}

export interface HatchetRequest {
  method?: "GET" | "POST";
  query?: URLSearchParams;
  body?: unknown;
}

async function send(
  url: string,
  headers: Record<string, string>,
  req: HatchetRequest,
): Promise<Response> {
  const query = req.query?.toString();
  try {
    return await fetch(`${url}${query ? `?${query}` : ""}`, {
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

// --- The workspace's token ---------------------------------------------------

/** The workspace's tenant, or null when it has no token and none is shared. */
export async function readWorkspaceTenant(
  workspaceId: string,
): Promise<WorkspaceTenant | null> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows.hatchetToken")
    .lean();
  const stored = workspace?.workflows?.hatchetToken;
  const token = stored
    ? decryptString(stored)
    : process.env.HATCHET_CLIENT_TOKEN;
  return token ? tenantFromToken(token) : null;
}

/**
 * The workspace's tenant, created now if Mako operates the Hatchet and the
 * workspace has none yet. The one caller, the deploy, already runs once per
 * workspace at a time.
 */
export async function ensureWorkspaceTenant(
  workspaceId: string,
): Promise<WorkspaceTenant> {
  const existing = await readWorkspaceTenant(workspaceId);
  if (existing) return existing;
  const adminUrl = process.env.HATCHET_API_URL?.replace(/\/+$/, "");
  if (!process.env.HATCHET_ADMIN_PASSWORD || !adminUrl) {
    throw new HatchetError("No Hatchet token. Set HATCHET_CLIENT_TOKEN.", 400);
  }

  const login = await send(
    `${adminUrl}/api/v1/users/login`,
    {},
    {
      method: "POST",
      body: {
        email: ADMIN_EMAIL,
        password: process.env.HATCHET_ADMIN_PASSWORD,
      },
    },
  );
  const cookie = login.headers
    .getSetCookie()
    .map(c => c.split(";")[0])
    .join("; ");
  if (!login.ok || !cookie) {
    throw new HatchetError(`Hatchet admin login failed (${login.status})`, 502);
  }
  const admin = { Cookie: cookie };

  // Create the tenant, or find it if an earlier attempt created it and then
  // failed before saving the token: the slug is taken either way.
  const slug = `${workflowsNamePrefix()}${workspaceId}`;
  const created = await send(`${adminUrl}/api/v1/tenants`, admin, {
    method: "POST",
    body: { name: slug, slug },
  });
  let tenantId = created.ok
    ? ((await created.json()) as { metadata?: { id?: string } }).metadata?.id
    : undefined;
  if (!tenantId) {
    const memberships = await parse<{
      rows?: Array<{ tenant?: { slug?: string; metadata?: { id?: string } } }>;
    }>(
      await send(`${adminUrl}/api/v1/users/memberships`, admin, {}),
      "List Hatchet tenants",
    );
    tenantId = memberships.rows?.find(m => m.tenant?.slug === slug)?.tenant
      ?.metadata?.id;
  }
  if (!tenantId) {
    throw new HatchetError(
      `Could not create Hatchet tenant ${slug} (${created.status})`,
      502,
    );
  }

  const { token } = await parse<{ token: string }>(
    await send(`${adminUrl}/api/v1/tenants/${tenantId}/api-tokens`, admin, {
      method: "POST",
      body: { name: "mako", expiresIn: TOKEN_TTL },
    }),
    "Create Hatchet token",
  );
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $set: { "workflows.hatchetToken": encryptString(token) } },
  );
  logger.info("Created Hatchet tenant", { workspaceId, tenantId });
  return tenantFromToken(token);
}

// --- Tenant calls -----------------------------------------------------------

function tenantFetch(
  tenant: WorkspaceTenant,
  path: string,
  req: HatchetRequest = {},
): Promise<Response> {
  return send(
    `${tenant.apiUrl}${path}`,
    { Authorization: `Bearer ${tenant.token}` },
    req,
  );
}

export async function tenantJson<T>(
  tenant: WorkspaceTenant,
  path: string,
  req: HatchetRequest = {},
): Promise<T> {
  return parse<T>(await tenantFetch(tenant, path, req), `Hatchet ${path}`);
}

/** A Hatchet id: a UUID. Checked before one is put in a Hatchet path. */
export function isHatchetId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
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

/** Cancel or replay a run. The two Hatchet calls differ only in their path. */
export function runAction(
  tenant: WorkspaceTenant,
  action: "cancel" | "replay",
  runId: string,
): Promise<unknown> {
  return tenantJson(
    tenant,
    `/api/v1/stable/tenants/${tenant.tenantId}/tasks/${action}`,
    { method: "POST", body: { externalIds: [runId] } },
  );
}
