/**
 * GitHub App install callback. GitHub redirects here (the App's "Setup URL")
 * after a user installs/updates the app on an org or repo:
 *
 *   GET /api/github/setup?installation_id=123&setup_action=install&state=<signed>
 *
 * `state` is an HMAC-signed token (see install-state.ts) minted by
 * GET /github/install-url that pins the workspace + the admin who started the
 * flow. We verify it (signature, expiry, same user, admin role) before binding
 * the installation, then bounce back to the Transform UI. Installation access
 * tokens are never stored — they're minted on demand from the App private key.
 */
import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "crypto";

import { isAllowedOrigin } from "../auth/oauth-proxy";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { GitHubInstallation } from "../database/workspace-schema";
import { Types } from "mongoose";
import {
  exchangeInstallUserToken,
  getInstallationMeta,
  userControlsInstallation,
} from "../integrations/github/app-auth";
import { verifyInstallState } from "../integrations/github/install-state";
import {
  getGitHubAppWebhookSecret,
  isGitHubAppUserAuthConfigured,
} from "../integrations/github/config";
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
  installation?: { id?: number };
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
            installationId: p.installation?.id,
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
  // SECURITY: the state must be a token WE signed (HMAC keyed on SESSION_SECRET)
  // that pins the workspace + the user who started the flow. A client-forgeable
  // state would let an attacker bind someone else's installation to their own
  // workspace (IDOR / CSRF) and then read another tenant's private repos.
  const state = verifyInstallState(stateParam);
  const redirectBase = resolveReturnClientUrl(state?.clientUrl);
  const user = c.get("user");

  if (!user) {
    // Not logged in (cookie missing) — send to login, then back to the app.
    return c.redirect(`${redirectBase}/login`);
  }
  if (!installationIdRaw || !state) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }
  const { workspaceId } = state;
  if (!Types.ObjectId.isValid(workspaceId)) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }
  // The flow must be completed by the same user who started it…
  if (state.userId !== user.id) {
    return c.redirect(`${redirectBase}/?transformGithub=forbidden`);
  }
  // …and binding an installation is a deployment-config mutation → admin+.
  const isAdmin = await workspaceService.isAdmin(workspaceId, user.id);
  if (!isAdmin) {
    return c.redirect(`${redirectBase}/?transformGithub=forbidden`);
  }

  const installationId = Number(installationIdRaw);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }

  // SECURITY (ownership proof): the signed state proves *who* started the flow,
  // but `installation_id` is an attacker-controllable query param. Without
  // proving the user controls that installation, an admin could bind a victim
  // org's installation to their own workspace and read its private repos
  // (cross-tenant IDOR). Verify via the user-to-server OAuth flow that the
  // installation appears in the user's own GET /user/installations.
  if (!isGitHubAppUserAuthConfigured()) {
    logger.error(
      "Refusing GitHub install bind: App OAuth client not configured " +
        "(set GITHUB_APP_CLIENT_ID/SECRET and enable 'Request user " +
        "authorization (OAuth) during installation'), cannot verify ownership",
      { workspaceId, installationId },
    );
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }
  const code = c.req.query("code");
  if (!code) {
    // App is configured for user-auth but GitHub didn't send a code — refuse.
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }
  try {
    const userToken = await exchangeInstallUserToken(code);
    const owns = await userControlsInstallation(userToken, installationId);
    if (!owns) {
      logger.warn("GitHub install bind blocked: user does not control it", {
        workspaceId,
        installationId,
        userId: user.id,
      });
      return c.redirect(`${redirectBase}/?transformGithub=forbidden`);
    }
  } catch (error) {
    logger.error("Failed to verify GitHub installation ownership", { error });
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }

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
