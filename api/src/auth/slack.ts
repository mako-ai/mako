import { createHmac, timingSafeEqual } from "crypto";
import { loggers } from "../logging";
import { getProductionUrl } from "./oauth-proxy";

const logger = loggers.auth();

export type SlackInstallType = "bot" | "webhook";

/** Parsed oauth.v2.access response subset */
export interface SlackOAuthAccessResult {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: {
    url?: string;
    channel?: string;
    channel_id?: string;
    configuration_url?: string;
  };
  error?: string;
}

export interface SlackOAuthParsed {
  installType: SlackInstallType;
  teamId: string;
  teamName: string;
  botUserId?: string;
  botAccessToken?: string;
  scope?: string;
  incomingWebhook?: { url: string; channel: string; channelId: string };
}

function getHmacSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Missing HMAC secret: set SESSION_SECRET or ENCRYPTION_KEY",
    );
  }
  return secret;
}

export function getSlackCallbackRedirectUri(): string {
  const base = getProductionUrl();
  if (!base) {
    throw new Error("Missing PRODUCTION_URL or BASE_URL for Slack OAuth");
  }
  return `${base.replace(/\/$/, "")}/api/auth/slack/callback`;
}

export function slackOAuthConfigured(): boolean {
  return Boolean(
    process.env.SLACK_CLIENT_ID?.trim() && process.env.SLACK_CLIENT_SECRET?.trim(),
  );
}

export function assertSlackOAuthEnv(): void {
  if (!process.env.SLACK_CLIENT_ID?.trim()) {
    throw new Error("Missing SLACK_CLIENT_ID");
  }
  if (!process.env.SLACK_CLIENT_SECRET?.trim()) {
    throw new Error("Missing SLACK_CLIENT_SECRET");
  }
}

export interface SlackOAuthStatePayload {
  nonce: string;
  origin: string;
  workspaceId: string;
  installType: SlackInstallType;
  returnTo: string;
  userId: string;
}

/**
 * HMAC-signed OAuth state for Slack: CSRF nonce, redirect origin, and install context.
 */
export function encodeSlackOAuthState(payload: SlackOAuthStatePayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getHmacSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

export function decodeSlackOAuthState(
  state: string,
): SlackOAuthStatePayload | null {
  try {
    const dot = state.lastIndexOf(".");
    if (dot === -1) return null;
    const data = state.slice(0, dot);
    const signature = state.slice(dot + 1);
    const expected = createHmac("sha256", getHmacSecret())
      .update(data)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn("Slack OAuth state signature mismatch");
      return null;
    }
    const parsed = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.origin !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      (parsed.installType !== "bot" && parsed.installType !== "webhook") ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.userId !== "string"
    ) {
      return null;
    }
    return {
      nonce: parsed.nonce,
      origin: parsed.origin,
      workspaceId: parsed.workspaceId,
      installType: parsed.installType,
      returnTo: parsed.returnTo,
      userId: parsed.userId,
    };
  } catch {
    return null;
  }
}

/** Bot workspace install scopes */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
].join(",");

/** Per-rule incoming webhook */
export const SLACK_WEBHOOK_USER_SCOPE = "incoming-webhook";

export function buildSlackAuthorizeUrl(params: {
  state: string;
  installType: SlackInstallType;
}): string {
  assertSlackOAuthEnv();
  const redirectUri = getSlackCallbackRedirectUri();
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!.trim());
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", params.state);
  if (params.installType === "bot") {
    u.searchParams.set("scope", SLACK_BOT_SCOPES);
  } else {
    u.searchParams.set("user_scope", SLACK_WEBHOOK_USER_SCOPE);
  }
  return u.toString();
}

export async function exchangeSlackOAuthCode(
  code: string,
): Promise<SlackOAuthAccessResult> {
  assertSlackOAuthEnv();
  const redirectUri = getSlackCallbackRedirectUri();
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!.trim(),
    client_secret: process.env.SLACK_CLIENT_SECRET!.trim(),
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(
      `Slack oauth.v2.access HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as SlackOAuthAccessResult;
}

export function parseSlackOAuthResponse(
  raw: SlackOAuthAccessResult,
  installType: SlackInstallType,
): SlackOAuthParsed {
  if (!raw.ok) {
    throw new Error(raw.error || "Slack OAuth failed");
  }
  const teamId = raw.team?.id;
  const teamName = raw.team?.name;
  if (!teamId || !teamName) {
    throw new Error("Slack OAuth response missing team");
  }
  if (installType === "bot") {
    const token = raw.access_token;
    if (!token || !token.startsWith("xoxb-")) {
      throw new Error("Slack bot install did not return a bot token (xoxb-)");
    }
    if (!raw.bot_user_id) {
      throw new Error("Slack bot install missing bot_user_id");
    }
    return {
      installType: "bot",
      teamId,
      teamName,
      botUserId: raw.bot_user_id,
      botAccessToken: token,
      scope: raw.scope,
    };
  }
  const wh = raw.incoming_webhook;
  const url = wh?.url;
  const channelId = wh?.channel_id;
  const channel = wh?.channel || "";
  if (!url || !channelId) {
    throw new Error(
      "Slack incoming webhook install missing webhook URL or channel id",
    );
  }
  return {
    installType: "webhook",
    teamId,
    teamName,
    scope: raw.scope,
    incomingWebhook: { url, channel, channelId },
  };
}

/** Short-lived signed payload so the app can claim the webhook URL without exposing it in long-lived URLs. */
export interface SlackWebhookClaimPayload {
  workspaceId: string;
  webhookUrl: string;
  channelLabel: string;
  exp: number;
}

export function signSlackWebhookClaim(payload: SlackWebhookClaimPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getHmacSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

export function verifySlackWebhookClaim(
  token: string,
): SlackWebhookClaimPayload | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const data = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = createHmac("sha256", getHmacSecret())
      .update(data)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.webhookUrl !== "string" ||
      typeof parsed.channelLabel !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Date.now()) {
      return null;
    }
    return {
      workspaceId: parsed.workspaceId,
      webhookUrl: parsed.webhookUrl,
      channelLabel: parsed.channelLabel,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

/** Lets production start Slack OAuth when the user authenticated on preview/local API (same secret as callback state). */
export interface SlackInstallTicketPayload {
  workspaceId: string;
  userId: string;
  installType: SlackInstallType;
  returnTo: string;
  callerOrigin: string;
  exp: number;
}

export function signSlackInstallTicket(
  payload: Omit<SlackInstallTicketPayload, "exp"> & { exp?: number },
): string {
  const full: SlackInstallTicketPayload = {
    ...payload,
    exp: payload.exp ?? Date.now() + 120_000,
  };
  const data = Buffer.from(JSON.stringify(full)).toString("base64url");
  const signature = createHmac("sha256", getHmacSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

export function verifySlackInstallTicket(
  token: string,
): SlackInstallTicketPayload | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const data = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = createHmac("sha256", getHmacSecret())
      .update(data)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.userId !== "string" ||
      (parsed.installType !== "bot" && parsed.installType !== "webhook") ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.callerOrigin !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Date.now()) {
      return null;
    }
    return {
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
      installType: parsed.installType,
      returnTo: parsed.returnTo,
      callerOrigin: parsed.callerOrigin,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
