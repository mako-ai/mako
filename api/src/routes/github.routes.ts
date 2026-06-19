/**
 * GitHub App install callback. GitHub redirects here (the App's "Setup URL")
 * after a user installs/updates the app on an org or repo:
 *
 *   GET /api/github/setup?installation_id=123&setup_action=install&state=<workspaceId>
 *
 * We record the installation against the workspace carried in `state` (the
 * browser redirect carries the session cookie, so we know who the user is),
 * then bounce back to the Transform UI. Installation access tokens are never
 * stored — they're minted on demand from the App private key.
 */
import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "crypto";

import { isAllowedOrigin } from "../auth/oauth-proxy";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { GitHubInstallation } from "../database/workspace-schema";
import { Types } from "mongoose";
import { getInstallationMeta } from "../integrations/github/app-auth";
import { getGitHubAppWebhookSecret } from "../integrations/github/config";
import { handlePullRequestEvent, handlePushEvent } from "../dbt/dbt-ci.service";
import { workspaceService } from "../services/workspace.service";
import { loggers } from "../logging";

const logger = loggers.api("github");

export const githubRoutes = new Hono();

// Auth only the interactive install callback. The webhook is unauthenticated
// (GitHub calls it) and instead verified by HMAC signature below.
githubRoutes.use("/setup", unifiedAuthMiddleware);

function clientUrl(): string {
  return process.env.CLIENT_URL || "http://localhost:5173";
}

/** Install flow state: plain workspace id (legacy) or JSON { workspaceId, clientUrl }. */
function parseInstallState(stateParam: string | undefined): {
  workspaceId: string | undefined;
  returnClientUrl: string | undefined;
} {
  if (!stateParam) {
    return { workspaceId: undefined, returnClientUrl: undefined };
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(stateParam)) as {
      workspaceId?: string;
      clientUrl?: string;
    };
    if (parsed.workspaceId) {
      return {
        workspaceId: parsed.workspaceId,
        returnClientUrl: parsed.clientUrl,
      };
    }
  } catch {
    // Legacy: state is the workspace id string.
  }
  return { workspaceId: stateParam, returnClientUrl: undefined };
}

function resolveReturnClientUrl(returnClientUrl: string | undefined): string {
  if (returnClientUrl && isAllowedOrigin(returnClientUrl)) {
    return returnClientUrl;
  }
  return clientUrl();
}

/** Constant-time compare of the X-Hub-Signature-256 header against the body. */
function verifySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { name?: string; owner?: { login?: string } };
}

interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  };
  repository?: { name?: string; owner?: { login?: string } };
  installation?: { id?: number };
}

interface InstallationPayload {
  action?: string;
  installation?: { id?: number };
}

/**
 * GitHub App webhook. Verified by HMAC; routes push (continuous sync),
 * pull_request (Slim CI), and installation (cleanup) events. Work is detached
 * so we ack within GitHub's delivery timeout.
 */
githubRoutes.post("/webhook", async (c: Context) => {
  const secret = getGitHubAppWebhookSecret();
  if (!secret) {
    logger.warn("GitHub webhook received but GITHUB_APP_WEBHOOK_SECRET unset");
    return c.json({ ok: false, error: "webhook not configured" }, 503);
  }

  const raw = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  if (!verifySignature(raw, signature, secret)) {
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }

  if (event === "ping") return c.json({ ok: true, pong: true });

  // Detach the actual work — syncing/CI can outlast the delivery window.
  void (async () => {
    try {
      if (event === "push") {
        const p = payload as PushPayload;
        const owner = p.repository?.owner?.login;
        const name = p.repository?.name;
        const ref = p.ref ?? "";
        if (owner && name && ref.startsWith("refs/heads/")) {
          await handlePushEvent({
            owner,
            repo: name,
            branch: ref.slice("refs/heads/".length),
          });
        }
      } else if (event === "pull_request") {
        const p = payload as PullRequestPayload;
        const owner = p.repository?.owner?.login;
        const name = p.repository?.name;
        const head = p.pull_request?.head;
        if (owner && name && p.number && head?.ref && head?.sha) {
          await handlePullRequestEvent({
            action: p.action ?? "",
            number: p.number,
            headRef: head.ref,
            headSha: head.sha,
            baseRef: p.pull_request?.base?.ref ?? "",
            owner,
            repo: name,
            installationId: p.installation?.id,
          });
        }
      } else if (event === "installation") {
        const p = payload as InstallationPayload;
        if (p.action === "deleted" && p.installation?.id) {
          await GitHubInstallation.deleteMany({
            installationId: p.installation.id,
          });
          logger.info("Removed GitHub installation (uninstalled)", {
            installationId: p.installation.id,
          });
        }
      }
    } catch (error) {
      logger.error("GitHub webhook processing failed", {
        event,
        error: String(error),
      });
    }
  })();

  return c.json({ ok: true, event }, 202);
});

githubRoutes.get("/setup", async (c: AuthenticatedContext) => {
  const installationIdRaw = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const stateParam = c.req.query("state");
  const { workspaceId, returnClientUrl } = parseInstallState(stateParam);
  const redirectBase = resolveReturnClientUrl(returnClientUrl);
  const user = c.get("user");

  if (!user) {
    // Not logged in (cookie missing) — send to login, then back to the app.
    return c.redirect(`${redirectBase}/login`);
  }
  if (!installationIdRaw || !workspaceId) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }
  if (!Types.ObjectId.isValid(workspaceId)) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }

  const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
  if (!hasAccess) {
    return c.redirect(`${redirectBase}/?transformGithub=forbidden`);
  }

  const installationId = Number(installationIdRaw);
  try {
    const meta = await getInstallationMeta(installationId);
    await GitHubInstallation.findOneAndUpdate(
      { workspaceId: new Types.ObjectId(workspaceId), installationId },
      {
        $set: {
          accountLogin: meta.accountLogin,
          accountType: meta.accountType,
          repositorySelection: meta.repositorySelection,
        },
        $setOnInsert: { createdBy: user.id },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    logger.info("GitHub App installation recorded", {
      workspaceId,
      installationId,
      setupAction,
    });
  } catch (error) {
    logger.error("Failed to record GitHub installation", { error });
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }

  return c.redirect(`${redirectBase}/?transformGithub=connected`);
});
