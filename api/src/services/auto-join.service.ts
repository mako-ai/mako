/**
 * Domain auto-join (apps.md §27).
 *
 * The flow it exists for: a rep gets the published app's link, clicks, signs
 * in with Google, and is in — no invitation. A workspace lists the email
 * domains it trusts and the access role newcomers get. Then, the general
 * case Théo wants: the newcomer WAITS ("veuillez attendre qu'un
 * administrateur finalise votre inscription"), the admins' Slack channel is
 * told "please assign role and country to <email>", and once an admin sets
 * the job role on the Members page the person gets an email and the page
 * lets them through. A workspace that sets a default job role skips the
 * queue. Exact domain match only: a sub-domain is somebody else's.
 */
import { Types } from "mongoose";
import {
  isCountryCode,
  isJobRole,
  JOB_ROLE_LABELS,
  type JobRole,
} from "@mako/schemas";
import {
  Workspace,
  WorkspaceMember,
  decrypt,
  type IWorkspaceAutoJoin,
  type IWorkspaceMember,
} from "../database/workspace-schema";
import { emailService } from "./email.service";
import { loggers } from "../logging";

const logger = loggers.workspace();

const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** How the outside world is told — injectable so tests see the messages. */
export interface AutoJoinHooks {
  slack: (text: string, webhookUrl: string) => Promise<void>;
  email: (
    to: string,
    subject: string,
    body: { html: string; text: string },
  ) => Promise<void>;
}

async function postSlack(text: string, webhookUrl: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook HTTP ${response.status}`);
  }
}

const defaultHooks: AutoJoinHooks = {
  slack: postSlack,
  email: (to, subject, body) =>
    emailService.sendFlowRunNotificationEmails([to], { subject, ...body }),
};

/**
 * Clean a submitted auto-join block: domains lowercased, de-duplicated,
 * a leading `@` tolerated, junk dropped. Null when nothing valid is left —
 * which also means "turn auto-join off". The Slack webhook is handled by
 * the route (it is stored encrypted).
 */
export function normalizeAutoJoin(
  input: {
    domains?: unknown;
    role?: unknown;
    jobRole?: unknown;
    country?: unknown;
  } | null,
): IWorkspaceAutoJoin | null {
  if (!input || typeof input !== "object") return null;
  const raw = Array.isArray(input.domains) ? input.domains : [];
  const domains: string[] = [];
  for (const d of raw) {
    if (typeof d !== "string") continue;
    const clean = d.trim().toLowerCase().replace(/^@/, "");
    if (DOMAIN_RE.test(clean) && !domains.includes(clean)) domains.push(clean);
  }
  if (domains.length === 0) return null;
  const out: IWorkspaceAutoJoin = {
    domains,
    role: input.role === "member" ? "member" : "viewer",
  };
  if (isJobRole(input.jobRole)) out.jobRole = input.jobRole;
  if (typeof input.country === "string") {
    const c = input.country.trim().toUpperCase();
    if (isCountryCode(c)) out.country = c;
  }
  return out;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() || null
  );
}

function clientUrl(): string {
  return (process.env.CLIENT_URL || "https://app.mako.ai").replace(/\/+$/, "");
}

function safeReturnTo(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  return value.slice(0, 500);
}

type AutoJoinWorkspace = {
  name?: string;
  settings?: { autoJoin?: IWorkspaceAutoJoin };
};

/**
 * The person's membership in `workspaceId`, creating it when the workspace
 * auto-joins their email domain. Null when they are not a member and the
 * domain is not trusted. Safe to call on every request: one read for a
 * member, and the (workspaceId, userId) unique index makes a concurrent
 * first contact create exactly one row.
 */
export async function ensureAutoJoin(
  workspaceId: string,
  user: { id: string; email?: string | null },
  opts: { returnTo?: string; hooks?: AutoJoinHooks } = {},
): Promise<IWorkspaceMember | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const wsId = new Types.ObjectId(workspaceId);
  const existing = await WorkspaceMember.findOne({
    workspaceId: wsId,
    userId: user.id,
  });
  if (existing) return existing;

  const domain = user.email ? emailDomain(user.email) : null;
  if (!domain) return null;
  const workspace = await Workspace.findById(wsId)
    .select("name settings.autoJoin")
    .lean<AutoJoinWorkspace>();
  const autoJoin = workspace?.settings?.autoJoin;
  if (!autoJoin || !autoJoin.domains?.includes(domain)) return null;

  const pending = !autoJoin.jobRole;
  const returnTo = pending ? safeReturnTo(opts.returnTo) : undefined;
  let member: IWorkspaceMember;
  try {
    member = await WorkspaceMember.create({
      workspaceId: wsId,
      userId: user.id,
      role: autoJoin.role ?? "viewer",
      ...(autoJoin.jobRole ? { jobRole: autoJoin.jobRole } : {}),
      ...(autoJoin.country ? { country: autoJoin.country } : {}),
      ...(pending ? { profilePending: true } : {}),
      ...(returnTo ? { pendingReturnTo: returnTo } : {}),
      joinedAt: new Date(),
    });
  } catch (error) {
    // Lost a race with another first request: the row now exists.
    if ((error as { code?: number }).code === 11000) {
      return WorkspaceMember.findOne({ workspaceId: wsId, userId: user.id });
    }
    throw error;
  }
  logger.info("Auto-joined a member by email domain", {
    workspaceId,
    userId: user.id,
    domain,
    role: member.role,
    jobRole: member.jobRole ?? null,
    pending,
  });

  if (pending && autoJoin.slackWebhookUrlEncrypted) {
    const hooks = opts.hooks ?? defaultHooks;
    const membersUrl = `${clientUrl()}/settings/members`;
    const text =
      `:new: *${user.email}* vient de rejoindre *${workspace?.name ?? "Mako"}* et attend son rôle.\n` +
      `Please assign role and country to ${user.email} — <${membersUrl}|Members page>.`;
    try {
      await hooks.slack(
        text,
        hooks === defaultHooks
          ? decrypt(autoJoin.slackWebhookUrlEncrypted)
          : "test",
      );
    } catch (error) {
      logger.warn("Auto-join Slack notification failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return member;
}

/**
 * An admin set the job role of a member who was waiting: clear the wait,
 * email the person ("c'est bon, tu peux y aller" with the link they wanted),
 * and close the loop in the admins' Slack channel. True when there was
 * something to complete.
 */
export async function completePendingProfile(
  workspaceId: string,
  userId: string,
  done: {
    email: string;
    jobRole: JobRole | string;
    country?: string | null;
    actor?: string;
  },
  hooks: AutoJoinHooks = defaultHooks,
): Promise<boolean> {
  const wsId = new Types.ObjectId(workspaceId);
  const member = await WorkspaceMember.findOneAndUpdate(
    { workspaceId: wsId, userId, profilePending: true },
    { $unset: { profilePending: 1, pendingReturnTo: 1 } },
    { new: false },
  );
  if (!member) return false;
  const workspace = await Workspace.findById(wsId)
    .select("name settings.autoJoin")
    .lean<AutoJoinWorkspace>();
  const name = workspace?.name ?? "Mako";
  const link = `${clientUrl()}${member.pendingReturnTo ?? "/"}`;
  const label = isJobRole(done.jobRole)
    ? JOB_ROLE_LABELS[done.jobRole]
    : String(done.jobRole);
  const country = done.country ? ` · ${done.country}` : "";
  try {
    await hooks.email(done.email, `Votre accès ${name} est prêt`, {
      text:
        `Bonjour,\n\nUn administrateur a finalisé votre inscription sur ${name} : rôle ${label}` +
        (done.country ? `, pays ${done.country}` : "") +
        `.\n\nVous pouvez y aller : ${link}\n`,
      html:
        `<p>Bonjour,</p><p>Un administrateur a finalisé votre inscription sur <b>${name}</b> : rôle <b>${label}</b>` +
        (done.country ? `, pays <b>${done.country}</b>` : "") +
        `.</p><p><a href="${link}">Vous pouvez y aller →</a></p>`,
    });
  } catch (error) {
    logger.warn("Profile-complete email failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const webhook = workspace?.settings?.autoJoin?.slackWebhookUrlEncrypted;
  if (webhook) {
    try {
      await hooks.slack(
        `:white_check_mark: ${done.email} → ${label}${country}` +
          (done.actor ? ` (par ${done.actor})` : "") +
          ". La personne a été prévenue par email.",
        hooks === defaultHooks ? decrypt(webhook) : "test",
      );
    } catch (error) {
      logger.warn("Profile-complete Slack notification failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return true;
}

/** The page a waiting member sees instead of an app. Reloads itself. */
export function pendingProfileHtml(input: {
  email: string;
  workspaceName: string;
}): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[
          c
        ] as string,
    );
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>Inscription en attente — ${esc(input.workspaceName)}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px 36px;max-width:520px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0;line-height:1.5;color:#3c3c3c}.muted{color:#7a7a7a;font-size:13px}</style></head>
<body><div class="card">
<h1>Veuillez attendre qu'un administrateur finalise votre inscription</h1>
<p>Vous êtes connecté à <b>${esc(input.workspaceName)}</b> en tant que <b>${esc(input.email)}</b>. Un administrateur doit encore vous attribuer un rôle et un pays.</p>
<p>Les administrateurs ont été prévenus. Vous recevrez un email dès que c'est fait — cette page se rafraîchit toute seule.</p>
<p class="muted">Please wait for an administrator to finish your signup. This page refreshes itself.</p>
</div></body></html>`;
}
