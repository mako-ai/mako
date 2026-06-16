import type { IUser } from "../database/schema";
import { loggers } from "../logging";
import { toPgId, toPgIdOrNull } from "./ids";
import {
  connectionsRepository,
  usersRepository,
  workspacesRepository,
} from "./repositories";

const log = loggers.db();

/**
 * Mongo -> Postgres dual-write.
 *
 * During the gradual migration, Mongo remains the system of record while these
 * helpers mirror writes into Postgres so the PG store stays current beyond the
 * point-in-time backfill. They are wired as Mongoose `post('save')` hooks on the
 * source models and are best-effort: failures are logged, never thrown (the
 * backfill reconciles any drift). Flip to a hard-fail / PG-authoritative policy
 * per domain once its reads have been cut over.
 *
 * Enabled when either:
 *   - `POSTGRES_DUAL_WRITE=true` (mirror all migrated domains), or
 *   - `AUTH_PERSISTENCE=postgres` (auth reads from PG, so users MUST be mirrored)
 */
export function dualWriteEnabled(): boolean {
  return (
    process.env.POSTGRES_DUAL_WRITE === "true" ||
    process.env.AUTH_PERSISTENCE === "postgres"
  );
}

export async function mirrorUser(user: IUser): Promise<void> {
  if (!dualWriteEnabled()) return;
  try {
    await usersRepository.upsert({
      id: toPgId(String(user._id)),
      email: String(user.email).toLowerCase(),
      hashedPassword: user.hashedPassword ?? null,
      emailVerified: user.emailVerified ?? false,
      onboarding: (user.onboarding as never) ?? null,
    });
  } catch (error) {
    log.error("dual-write user -> postgres failed", {
      error,
      userId: String(user._id),
    });
  }
}

export async function mirrorWorkspace(ws: {
  _id: unknown;
  name: string;
  slug: string;
  createdBy: string;
  settings?: unknown;
  billing?: unknown;
  selfDirective?: string;
}): Promise<void> {
  if (!dualWriteEnabled()) return;
  try {
    await workspacesRepository.upsert({
      id: toPgId(String(ws._id)),
      name: ws.name,
      slug: String(ws.slug).toLowerCase(),
      createdBy: toPgId(String(ws.createdBy)),
      settings: (ws.settings as never) ?? null,
      billing: (ws.billing as never) ?? null,
      selfDirective: ws.selfDirective ?? "",
    });
  } catch (error) {
    log.error("dual-write workspace -> postgres failed", {
      error,
      workspaceId: String(ws._id),
    });
  }
}

export async function mirrorWorkspaceMember(m: {
  workspaceId: unknown;
  userId: string;
  role: string;
  isDefaultMembership?: boolean;
}): Promise<void> {
  if (!dualWriteEnabled()) return;
  try {
    await workspacesRepository.addMember({
      workspaceId: toPgId(String(m.workspaceId)),
      userId: toPgId(String(m.userId)),
      role: m.role as "owner" | "admin" | "member" | "viewer",
      isDefaultMembership: m.isDefaultMembership ?? null,
    });
  } catch (error) {
    log.error("dual-write workspace_member -> postgres failed", {
      error,
      workspaceId: String(m.workspaceId),
      userId: String(m.userId),
    });
  }
}

export async function mirrorDatabaseConnection(conn: {
  _id: unknown;
  workspaceId: unknown;
  name: string;
  type: string;
  // Plaintext when read off a Mongoose doc (getters decrypt); the repository
  // re-encrypts on write.
  connection: Record<string, unknown>;
  isDemo?: boolean;
  createdBy: string;
  lastConnectedAt?: Date | null;
}): Promise<void> {
  if (!dualWriteEnabled()) return;
  try {
    await connectionsRepository.upsert({
      id: toPgId(String(conn._id)),
      workspaceId: toPgId(String(conn.workspaceId)),
      name: conn.name,
      type: conn.type as never,
      connection: conn.connection ?? {},
      isDemo: conn.isDemo ?? false,
      createdBy: toPgId(String(conn.createdBy)),
      lastConnectedAt: conn.lastConnectedAt ?? null,
    });
  } catch (error) {
    log.error("dual-write database_connection -> postgres failed", {
      error,
      connectionId: String(conn._id),
    });
  }
}

export { toPgIdOrNull };
