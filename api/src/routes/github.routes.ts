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

import { getRequestOrigin, isAllowedOrigin } from "../auth/oauth-proxy";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { GitHubInstallation } from "../database/workspace-schema";
import { Types } from "mongoose";
import {
  exchangeInstallUserToken,
  getInstallationMeta,
  listUserInstallations,
  userControlsInstallation,
} from "../integrations/github/app-auth";
import {
  peekInstallState,
  verifyInstallState,
} from "../integrations/github/install-state";
import {
  getGitHubAppWebhookSecret,
  isGitHubAppUserAuthConfigured,
} from "../integrations/github/config";
import { handlePullRequestEvent, handlePushEvent } from "../dbt/dbt-ci.service";
import { workspaceService } from "../services/workspace.service";
import { loggers } from "../logging";
import { deployAppsForPush } from "../apps/deploy-on-push";
import { ensureLocalRepo, fetchFromCloud } from "../apps/cloud-repo.service";
import { findWorkspaceIdByRepoBinding } from "../services/workspace-repos.service";
import { repoDirFor } from "../apps/repository.service";
import { syncConsolesIndexFromRepo } from "../apps/workspace-consoles.service";
import { syncSkillsIndexFromRepo } from "../apps/workspace-skills.service";

const logger = loggers.api("github");

export const githubRoutes = new Hono();

// Cross-environment relay — MUST run before auth. The GitHub App has a single
// callback URL (production's), so installs started on localhost or a PR
// preview land here without a session and would 401 before the handler even
// runs. The state payload embeds the initiating environment's clientUrl; when
// that names a DIFFERENT allowed Mako origin, bounce the entire callback
// (installation_id, code, state) there. The receiving environment — the one
// that actually minted the state — then performs the real verification
// (signature with its own secret, session, admin role, install ownership) and
// binds into its own database. Mirrors the login OAuth proxy (oauth-proxy.ts).
// The relay itself grants nothing: a forged state just gets bounced to an
// allowed origin whose verification then rejects it.
githubRoutes.use("/setup", async (c, next) => {
  if (c.req.query("relayed")) return next(); // never relay twice
  const peeked = peekInstallState(c.req.query("state"));
  if (!peeked?.clientUrl || !isAllowedOrigin(peeked.clientUrl)) return next();
  const targetOrigin = new URL(peeked.clientUrl).origin;
  if (targetOrigin === getRequestOrigin(c)) return next();
  const target = new URL(`${targetOrigin}/api/github/setup`);
  for (const [key, value] of Object.entries(c.req.query())) {
    target.searchParams.set(key, value);
  }
  target.searchParams.set("relayed", "1");
  logger.info("Relaying GitHub install callback to its origin", {
    targetOrigin,
  });
  return c.redirect(target.toString());
});

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
  before?: string;
  after?: string;
  repository?: {
    name?: string;
    owner?: { login?: string };
    default_branch?: string;
  };
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
/**
 * Deploy any Apps apps touched by a push to the workspace repo's default
 * branch. No-op for repos that are not workspace repos.
 */
async function handleAppsPush(input: {
  owner: string;
  repo: string;
  branch: string;
  before?: string;
  after?: string;
  defaultBranch?: string;
}): Promise<void> {
  const { owner, repo, branch, before, after, defaultBranch } = input;
  if (!after) return;
  // The customer's own repo is the durable mirror (§13.17); the push is
  // matched through the workspace's binding.
  const workspaceId = await findWorkspaceIdByRepoBinding(owner, repo);
  if (!workspaceId) return;
  if (branch !== (defaultBranch || "main")) return;

  // The bare repo is a cache; the commit arrived at GitHub, so pull it in
  // before trying to build it — and on a fresh serverless instance the cache
  // may not exist at all yet.
  await ensureLocalRepo(workspaceId);
  await fetchFromCloud(workspaceId, branch);
  // A console committed on GitHub (laptop clone, PR merge) is in the index
  // before anyone opens the app (apps.md §16.3).
  void syncConsolesIndexFromRepo(workspaceId).catch(error => {
    logger.warn("Console index sync after GitHub push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void syncSkillsIndexFromRepo(workspaceId).catch(error => {
    logger.warn("Skills index sync after GitHub push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Builds run as Inngest work (apps-deploy) — this only decides what changed.
  const requested = await deployAppsForPush({
    workspaceId,
    repoDir: repoDirFor(workspaceId),
    before,
    after,
  });
  if (requested.length > 0) {
    logger.info("Requested app deploys from a push to main", {
      workspaceId,
      apps: requested,
    });
  }
}

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
          const branch = ref.slice("refs/heads/".length);
          await handlePushEvent({
            owner,
            repo: name,
            branch,
            installationId: p.installation?.id,
          });
          // Apps: `main` is production, so putting a commit on it IS the
          // act of deploying — whether that came from a local `git push`, a
          // merge on GitHub, or the Publish button. Handled here because
          // GitHub is the one point all of those converge on.
          await handleAppsPush({
            owner,
            repo: name,
            branch,
            before: p.before,
            after: p.after,
            defaultBranch: p.repository?.default_branch,
          }).catch(error => {
            logger.error("Apps deploy-on-push failed", { error });
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
  if (!state) {
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

  // Sync-existing flow: no installation_id means this is the callback of the
  // user-authorization OAuth flow (github.com/login/oauth/authorize), not an
  // install. GitHub never fires the install callback for an account where the
  // app is ALREADY installed (its install page short-circuits to
  // "Configure"), so this is the only way to bind such installations: use
  // the code to list every installation the user controls and record the
  // ones this workspace is missing. Ownership proof is inherent — the list
  // comes from the user's own token.
  const syncCode = c.req.query("code");
  if (!installationIdRaw && syncCode) {
    try {
      const userToken = await exchangeInstallUserToken(syncCode);
      const controlled = await listUserInstallations(userToken);
      for (const inst of controlled) {
        await GitHubInstallation.findOneAndUpdate(
          {
            workspaceId: new Types.ObjectId(workspaceId),
            installationId: inst.id,
          },
          {
            $set: {
              accountLogin: inst.accountLogin,
              accountType: inst.accountType,
              repositorySelection: inst.repositorySelection,
            },
            $setOnInsert: { createdBy: user.id },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }
      logger.info("GitHub installations synced from user authorization", {
        workspaceId,
        count: controlled.length,
      });
      // The sync runs in a popup the Settings page opened — don't load the
      // whole SPA in it, just close it. Refocusing the opener triggers the
      // Settings page's focus-refresh, which picks up the synced accounts.
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;padding:2rem;text-align:center">
<p>GitHub accounts synced — you can close this window.</p>
<script>window.close();</script>
</body></html>`,
      );
    } catch (error) {
      logger.error("Failed to sync GitHub installations", { error });
      return c.redirect(`${redirectBase}/?transformGithub=error`);
    }
  }
  if (!installationIdRaw) {
    return c.redirect(`${redirectBase}/?transformGithub=error`);
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
    // GitHub allows at most one live installation of this App per account, so
    // any other record for the same workspace + account is provably stale —
    // left behind by an uninstall/reinstall cycle whose webhook never reached
    // this environment's database (webhooks fan out to one configured URL,
    // not every dev/staging/preview deployment). Prune them here so
    // reinstalling through the UI is a real fix, not just a second, visually
    // identical entry in the account picker.
    const { deletedCount } = await GitHubInstallation.deleteMany({
      workspaceId: new Types.ObjectId(workspaceId),
      accountLogin: meta.accountLogin,
      installationId: { $ne: installationId },
    });
    logger.info("GitHub App installation recorded", {
      workspaceId,
      installationId,
      setupAction,
      staleInstallationsRemoved: deletedCount,
    });
  } catch (error) {
    logger.error("Failed to record GitHub installation", { error });
    return c.redirect(`${redirectBase}/?transformGithub=error`);
  }

  return c.redirect(`${redirectBase}/?transformGithub=connected`);
});
