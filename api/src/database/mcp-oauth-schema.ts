/**
 * OAuth 2.1 authorization-server state for the Mako MCP endpoint.
 *
 * MCP clients (Claude, Cursor, Codex, …) connect with nothing but the server
 * URL: they discover this AS via RFC 9728 resource metadata, register
 * themselves (RFC 7591), and send the user through /authorize where they sign
 * in with their Mako account and pick a workspace. No API keys to hand out.
 *
 * All secrets (codes, access + refresh tokens) are stored as SHA-256 hashes;
 * the plaintext exists only in the response that first issues it. Codes and
 * tokens carry the workspace binding chosen at consent time.
 */
import mongoose, { Document, Schema, Types } from "mongoose";

/** Dynamically-registered OAuth client (public client, PKCE-only). */
export interface IMcpOAuthClient extends Document {
  _id: Types.ObjectId;
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: Date;
}

const McpOAuthClientSchema = new Schema<IMcpOAuthClient>({
  clientId: { type: String, required: true, unique: true },
  clientName: { type: String },
  redirectUris: { type: [String], required: true },
  createdAt: { type: Date, default: Date.now },
});

/** Short-lived authorization code (single use, PKCE S256 bound). */
export interface IMcpOAuthCode extends Document {
  _id: Types.ObjectId;
  codeHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: Date;
  usedAt?: Date;
}

const McpOAuthCodeSchema = new Schema<IMcpOAuthCode>({
  codeHash: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  userId: { type: String, required: true },
  workspaceId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  codeChallenge: { type: String, required: true },
  scopes: { type: [String], required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date },
});
McpOAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Issued access + refresh token pair, bound to user × workspace × client. */
export interface IMcpOAuthToken extends Document {
  _id: Types.ObjectId;
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  /** Server-generated identity for one attached Desktop ACP session. */
  agentSessionId?: string;
  scopes: string[];
  accessExpiresAt: Date;
  /** Absent for CLI / external MCP grants, which last until revoked. */
  refreshExpiresAt?: Date;
  createdAt: Date;
  lastUsedAt?: Date;
}

const McpOAuthTokenSchema = new Schema<IMcpOAuthToken>({
  accessTokenHash: { type: String, required: true, unique: true },
  refreshTokenHash: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  userId: { type: String, required: true },
  workspaceId: { type: String, required: true },
  agentSessionId: { type: String, index: true },
  scopes: { type: [String], required: true },
  accessExpiresAt: { type: Date, required: true },
  refreshExpiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date },
});
// TTL skips grants without a date; only expiring legacy / ACP grants are reaped.
McpOAuthTokenSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpOAuthClient = mongoose.model<IMcpOAuthClient>(
  "McpOAuthClient",
  McpOAuthClientSchema,
);
export const McpOAuthCode = mongoose.model<IMcpOAuthCode>(
  "McpOAuthCode",
  McpOAuthCodeSchema,
);
export const McpOAuthToken = mongoose.model<IMcpOAuthToken>(
  "McpOAuthToken",
  McpOAuthTokenSchema,
);
