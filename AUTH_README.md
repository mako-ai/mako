# Authentication System Implementation

This document provides a complete guide to the authentication system implemented for this TypeScript/React application.

## Architecture Overview

The authentication system consists of:

### Backend (API)

- **Lucia Auth**: Session management library
- **Arctic**: OAuth provider integration (Google & GitHub)
- **MongoDB**: Database for users, sessions, and OAuth accounts
- **Mongoose**: MongoDB ORM
- **bcrypt**: Password hashing
- **Rate limiting**: Protection against brute force attacks

### Frontend (App)

- **Auth Context**: React context for state management
- **Auth Client**: API wrapper for authentication endpoints
- **Protected Routes**: Component for route protection
- **API Client**: General API client with auth handling

## File Structure

```
api/
├── src/
│   ├── auth/
│   │   ├── lucia.ts          # Lucia configuration
│   │   ├── arctic.ts         # OAuth providers setup
│   │   ├── auth.service.ts   # Auth business logic
│   │   ├── auth.controller.ts# Route handlers
│   │   ├── auth.middleware.ts# Auth & rate limit middleware
│   │   ├── mongodb-adapter.ts# Lucia MongoDB adapter
│   │   └── index.ts          # Module exports
│   └── database/
│       └── schema.ts         # MongoDB schemas

app/
├── src/
│   ├── lib/
│   │   ├── auth-client.ts    # Auth API client
│   │   └── api-client.ts     # General API client
│   ├── contexts/
│   │   └── auth-context.tsx  # Auth context provider
│   ├── hooks/
│   │   └── useAuth.ts        # Auth hook
│   └── components/
│       └── ProtectedRoute.tsx# Route protection
```

## Setup Instructions

### 1. Environment Variables

Create a `.env` file in the root directory based on `.env.example`:

```bash
cp .env.example .env
```

Configure the following variables:

```env
# Database
DATABASE_URL=mongodb://localhost:27017/mako

# OAuth Providers
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GH_CLIENT_ID=your_github_client_id
GH_CLIENT_SECRET=your_github_client_secret

# Application URLs
# API server base URL and frontend URL
BASE_URL=http://localhost:8080
CLIENT_URL=http://localhost:5173

# Session Configuration
SESSION_SECRET=generate_32_char_random_string
SESSION_DURATION=86400000  # 24 hours in milliseconds

# Security
BCRYPT_ROUNDS=10
RATE_LIMIT_WINDOW_MS=900000     # 15 minutes
RATE_LIMIT_MAX_REQUESTS=5
```

### 2. OAuth Provider Setup

#### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:3001/api/auth/google/callback`
6. Copy Client ID and Client Secret to `.env`

#### GitHub OAuth Setup

1. Go to GitHub Settings > Developer settings > OAuth Apps
2. Create a new OAuth App
3. Set Authorization callback URL: `http://localhost:3001/api/auth/github/callback`
4. Copy Client ID and Client Secret to `.env`

### 3. Database Setup

Ensure MongoDB is running:

```bash
# Using Docker Compose (recommended)
pnpm run docker:up

# Or using Docker directly
docker run -d -p 27017:27017 --name mongodb mongo

# Or start local MongoDB
mongod
```

### 4. Start the Application

```bash
# Install dependencies
pnpm install

# Start development servers (API on 8080, app on 5173, Inngest dev)
pnpm run dev
```

## Usage Guide

### Frontend Integration

#### 1. Wrap App with Auth Provider

In your main app component:

```tsx
import { AuthProvider } from "./contexts/auth-context";

function App() {
  return <AuthProvider>{/* Your app components */}</AuthProvider>;
}
```

#### 2. Use Authentication in Components

```tsx
import { useAuth } from "./hooks/useAuth";

function LoginPage() {
  const { login, loginWithOAuth, error, loading } = useAuth();

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login({ email, password });
      // Redirect handled by auth context
    } catch (err) {
      // Error displayed in UI via error state
    }
  };

  return (
    <form onSubmit={handleLogin}>
      {error && <Alert severity="error">{error}</Alert>}
      {/* Form fields */}
      <Button onClick={() => loginWithOAuth("google")}>
        Login with Google
      </Button>
    </form>
  );
}
```

#### 3. Protect Routes

```tsx
import { ProtectedRoute } from "./components/ProtectedRoute";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
```

#### 4. Use API Client for Authenticated Requests

```tsx
import { apiClient } from "./lib/api-client";

// All requests automatically include authentication
const fetchUserData = async () => {
  const data = await apiClient.get("/user/profile");
  return data;
};
```

### Backend Integration

#### 1. Protect API Routes

```ts
import { unifiedAuthMiddleware } from "./auth/unified-auth.middleware";

// Require authentication (supports session or API key)
app.get("/api/protected", unifiedAuthMiddleware, c => {
  const user = c.get("user");
  return c.json({ message: "Protected data", userId: user.id });
});

// For machine-to-machine endpoints, you can still use API key middleware directly if needed.
```

#### 2. Access User in Routes

```ts
app.get("/api/user/profile", authMiddleware, async c => {
  const user = c.get("user");
  const session = c.get("session");

  // User is guaranteed to exist after authMiddleware
  return c.json({
    id: user.id,
    email: user.attributes.email,
    sessionExpiresAt: session.expiresAt,
  });
});
```

## API Endpoints

### Authentication Endpoints

| Method | Endpoint                    | Description                                 | Auth Required |
| ------ | --------------------------- | ------------------------------------------- | ------------- |
| POST   | `/api/auth/register`        | Register new user                           | No            |
| POST   | `/api/auth/login`           | Login with email/password                   | No            |
| POST   | `/api/auth/logout`          | Logout user                                 | Yes           |
| GET    | `/api/auth/me`              | Get current user                            | Yes           |
| POST   | `/api/auth/refresh`         | Refresh session                             | No            |
| GET    | `/api/auth/google`          | Initiate Google OAuth                       | No            |
| GET    | `/api/auth/google/callback` | Google OAuth callback                       | No            |
| GET    | `/api/auth/github`          | Initiate GitHub OAuth                       | No            |
| GET    | `/api/auth/github/callback` | GitHub OAuth callback                       | No            |
| GET    | `/api/auth/oauth-receive`   | Receive session from production OAuth proxy | No            |
| POST   | `/api/auth/desktop/code`    | Mint one-time desktop handoff code          | Yes           |
| GET    | `/api/auth/desktop/complete`| Redeem desktop code, set session cookie     | No (code+PKCE)|

### Request/Response Examples

#### Register

```bash
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123"
}

Response:
{
  "user": {
    "id": "abc123",
    "email": "user@example.com",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

#### Login

```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123"
}

Response:
{
  "user": {
    "id": "abc123",
    "email": "user@example.com",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

## Security Features

### Password Security

- Passwords hashed with bcrypt (configurable rounds)
- Minimum 8 character requirement
- Salted hashes stored in database

### Session Security

- HTTP-only cookies prevent XSS attacks
- SameSite=lax prevents CSRF
- Secure flag in production
- Configurable session duration
- Session invalidation on logout

### Rate Limiting

- Configurable window and max requests
- Per-endpoint + IP-based limiting
- Prevents brute force attacks

### OAuth Security

- State parameter prevents CSRF
- PKCE flow for Google OAuth
- Secure token exchange
- HMAC-signed OAuth state prevents origin tampering in cross-origin proxy flow
- Short-lived HMAC-signed transfer tokens for cross-origin session transfer

## OAuth Proxy Pattern (Cross-Origin Authentication)

Google and GitHub OAuth require declared HTTPS redirect URIs. Non-production
environments (localhost, PR previews) cannot register their own callback URLs.
Instead, they route through the production instance which is the only origin
registered with the OAuth providers.

### Environment Variables

| Variable          | Where               | Description                                                                 |
| ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `PRODUCTION_URL`  | Non-production only | Production API origin (e.g. `https://app.mako.co`). Unset in production.    |
| `TRUSTED_ORIGINS` | Production only     | Comma-separated list of additional trusted origins for redirect validation. |
| `DISABLE_OAUTH`   | Any                 | Hard kill switch. Set `true` to completely disable OAuth.                   |

### Flow: Production (unchanged)

```
Browser → GET /api/auth/google
  → set state cookie (nonce)
  → redirect to Google with redirect_uri = production callback
Google → GET /api/auth/google/callback (on production)
  → validate nonce, exchange code, create session
  → set session cookie, redirect to CLIENT_URL
```

### Flow: Non-Production (localhost, PR previews)

```
Browser (preview) → GET /api/auth/google
  → detect non-production
  → redirect to PRODUCTION_URL/api/auth/google?origin=<preview_origin>

Browser → GET /api/auth/google (on production)
  → validate origin with isAllowedOrigin()
  → encode { nonce, origin } into HMAC-signed state
  → set state cookie, redirect to Google

Google → GET /api/auth/google/callback (on production)
  → decode state, validate HMAC signature
  → validate nonce against cookie
  → validate origin with isAllowedOrigin()
  → exchange code, create session
  → create HMAC-signed transfer token (60s TTL)
  → redirect to <origin>/api/auth/oauth-receive?token=<transfer_token>

Browser → GET /api/auth/oauth-receive (on preview)
  → verify transfer token signature and expiry
  → validate session exists in database
  → set session cookie locally
  → redirect to CLIENT_URL
```

### Security Properties

- **CSRF protection**: The CSRF nonce is stored in an httpOnly cookie on the production domain and validated on callback.
- **Origin validation**: All redirect targets are validated against a domain allowlist (`*.mako.co`), localhost, and the `TRUSTED_ORIGINS` env var.
- **State integrity**: The OAuth state parameter is HMAC-signed with `SESSION_SECRET`/`ENCRYPTION_KEY` to prevent tampering with the caller origin.
- **Transfer token security**: The session is transmitted via a short-lived (60s) HMAC-signed token, not the raw session ID.
- **Backward compatible**: When `PRODUCTION_URL` is unset, the system behaves exactly as before (single-deployment mode).

### Key Files

| File                              | Purpose                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `api/src/auth/oauth-proxy.ts`     | Proxy helpers: origin detection, state encoding/decoding, transfer tokens, origin validation |
| `api/src/auth/arctic.ts`          | OAuth provider setup (callback URLs always point to production)                              |
| `api/src/auth/auth.controller.ts` | OAuth routes with proxy-aware initiation, callback, and `/oauth-receive` endpoint            |

## Desktop App Authentication (deep-link handoff)

Mako Desktop (Electron) never renders third-party login pages inside its own
window. Instead it hands authentication off to the user's system browser
(Slack/Notion model) where the URL bar, certificates, and password manager are
available, then receives the session back via a `mako://` deep link.

### Flow

```
Desktop app ("Continue with Google/GitHub" or "Sign in using your browser")
  → main process generates PKCE pair:
      verifier  = base64url(randomBytes(32))      (kept in memory, never leaves app)
      challenge = base64url(SHA-256(verifier))
  → opens SYSTEM BROWSER at {CLIENT_URL}/desktop-auth?challenge=<challenge>

Browser /desktop-auth
  → not signed in? challenge saved to sessionStorage, user logs in normally
    (Google/GitHub/email — full browser UI), then returns to /desktop-auth
  → signed in: POST /api/auth/desktop/code { challenge }   (session cookie auth)
      → server stores { _id: SHA-256(code), userId, challenge, expiresAt: +60s }
      → responds with the one-time raw code
  → triggers mako://auth?code=<code>  ("Open Mako" button)

Desktop app (deep link received: open-url on macOS, argv on Win/Linux)
  → loads {APP_URL}/api/auth/desktop/complete?code=<code>&verifier=<verifier>
    INSIDE the app window
      → server atomically consumes the code (findOneAndDelete by hash),
        checks expiry, verifies SHA-256(verifier) == stored challenge
      → creates a fresh session, sets auth_session cookie, redirects to CLIENT_URL
  → desktop window is now signed in
```

### Security Properties

- **No third-party login inside the app**: Google/GitHub pages only ever render
  in the user's real browser.
- **Single-use codes**: redeemed via atomic `findOneAndDelete`; replays fail.
- **Short TTL**: codes expire after 60 seconds (plus a TTL index for cleanup).
- **Hashed at rest**: only the SHA-256 of the code is stored; a database leak
  exposes nothing redeemable.
- **Mandatory PKCE**: the verifier never leaves the desktop app, so a malicious
  application that registers the `mako://` scheme and intercepts the deep link
  cannot redeem the stolen code.
- **Rate limited**: `POST /desktop/code` allows 10 requests/minute per IP.

### Key Files

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `api/src/auth/desktop-auth.ts`         | Code mint/redeem helpers (hashing, PKCE verification)    |
| `api/src/database/schema.ts`           | `DesktopAuthCode` model (TTL index on `expiresAt`)       |
| `api/src/auth/auth.controller.ts`      | `/desktop/code` and `/desktop/complete` routes           |
| `app/src/components/DesktopAuthPage.tsx` | Browser-side handoff page (`/desktop-auth`)            |
| `app/src/utils/desktop-auth-redirect.ts` | sessionStorage resume across the login round trip      |
| `packages/desktop/src/main.ts`         | PKCE generation, `mako://` protocol, deep-link handling  |

## MCP OAuth (AI agent connections)

The MCP endpoint (`POST /api/mcp`) accepts two credentials: a workspace API
key (`Authorization: Bearer revops_...`) or an OAuth 2.1 grant minted by
Mako's own built-in authorization server. Session cookies are rejected there
so the workspace binding is always unambiguous.

### Authorization server

Public clients only (`token_endpoint_auth_methods_supported: ["none"]`) with
mandatory PKCE S256 — the MCP spec's auth profile, implemented by Claude,
Cursor, and Codex. Clients self-register via RFC 7591 dynamic registration;
no provider console setup is needed.

| Method | Endpoint                  | Description                                        |
| ------ | ------------------------- | -------------------------------------------------- |
| POST   | `/api/oauth/mcp/register` | RFC 7591 dynamic client registration               |
| GET    | `/api/oauth/mcp/authorize`| Consent page (bounces through `/login` if needed)  |
| POST   | `/api/oauth/mcp/authorize`| Consent form submit → authorization code redirect  |
| POST   | `/api/oauth/mcp/token`    | Code/refresh-token exchange                        |

Discovery documents are mounted at root in `src/index.ts` (not in
`register-routes.ts`): `/.well-known/oauth-protected-resource` and six
authorization-server metadata spellings (RFC 8414 path-inserted variants plus
OIDC-discovery spellings). All variants serve the same metadata — a miss
would fall through to the SPA fallback and poison client discovery.

### Token model

- Opaque tokens, stored as SHA-256 hashes: access `mcpat_*` (8 h TTL),
  refresh `mcprt_*` (30 d TTL, rotated on every refresh). Auth codes live
  10 minutes and are consumed atomically.
- `unifiedAuthMiddleware` recognizes the `mcpat_` Bearer prefix and sets
  `authType: "mcpOAuth"` with the grant's workspace binding and scopes.
- Scopes are always the read-only set (`mcp`, `query:read`). There is
  deliberately no `query:write` scope — an OAuth grant can never do more
  than a freshly-created MCP API key.
- Redirect URIs accepted at registration: `https` anywhere, `http` on
  loopback only (RFC 8252), or a custom app scheme (e.g. `cursor://`).
  Max 10 per client.
- `lastUsedAt` is written at most once per minute per grant to avoid a
  DB write on every MCP request.

### Workspace API key scopes

Workspace API keys (`revops_*`) now carry a `scopes` array
(`api/src/auth/api-key-scopes.ts`). New keys default to
`["mcp", "query:read"]`. Legacy keys created before scopes existed have
`scopes: undefined` and are refused by the MCP endpoint with a rotation
hint — they keep working everywhere else.

### Managing connected agents

| Method | Endpoint                                        | Description                     |
| ------ | ----------------------------------------------- | ------------------------------- |
| GET    | `/api/workspaces/:id/mcp-connections`           | List agents connected via OAuth |
| DELETE | `/api/workspaces/:id/mcp-connections/:clientId` | Revoke an agent's grants        |

Members see and revoke their own connections; owners/admins see everyone's.
The app surface for this is **Settings → Connect Agents**.

### Key Files

| File                                    | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `api/src/routes/mcp-oauth.routes.ts`    | AS endpoints, well-known discovery documents, consent page      |
| `api/src/auth/mcp-oauth.service.ts`     | Code/token mint, exchange, refresh rotation, revocation         |
| `api/src/database/mcp-oauth-schema.ts`  | `McpOAuthClient`, `McpOAuthCode`, `McpOAuthToken` models        |
| `api/src/auth/api-key-scopes.ts`        | Scope constants, parsing, legacy-key resolution                 |
| `api/src/auth/unified-auth.middleware.ts` | `mcpat_` Bearer recognition alongside sessions and API keys   |
| `api/src/routes/mcp-server.routes.ts`   | `POST /api/mcp` — auth-type and scope enforcement               |

User-facing setup docs live in the Starlight site: `docs/src/content/docs/mcp-server.md`.


## Customization

### Adding New OAuth Providers

1. Install the provider in Arctic:

```ts
import { Facebook } from "arctic";

export const facebook = new Facebook(
  process.env.FACEBOOK_APP_ID!,
  process.env.FACEBOOK_APP_SECRET!,
  `${process.env.BASE_URL}/api/auth/facebook/callback`,
);
```

2. Add routes in auth controller
3. Update the auth service to handle the new provider

### Customizing Session Duration

Update the `.env` file:

```env
SESSION_DURATION=3600000  # 1 hour in milliseconds
```

### Adding Custom User Fields

1. Update the schema in `database/schema.ts`
2. Update the `DatabaseUserAttributes` interface in `lucia.ts`
3. Update the auth service to handle new fields

## Troubleshooting

### Common Issues

1. **"Cannot connect to MongoDB"**

   - Ensure MongoDB is running
   - Check DATABASE_URL in .env

2. **OAuth redirect errors**

   - Verify redirect URIs match in provider console
   - Check BASE_URL and CLIENT_URL

3. **Session not persisting**

   - Check cookie settings in browser
   - Ensure credentials: 'include' in fetch

4. **Rate limit errors during development**
   - Increase RATE_LIMIT_MAX_REQUESTS
   - Clear rate limit store by restarting server

## Production Considerations

1. **Environment Variables**

   - Use strong SESSION_SECRET (min 32 chars)
   - Set NODE_ENV=production
   - Use HTTPS URLs

2. **Database**

   - Add indexes for performance
   - Implement session cleanup job
   - Consider Redis for sessions at scale

3. **Security**

   - Enable secure cookies
   - Implement CORS properly
   - Add request validation
   - Log authentication events

4. **Monitoring**
   - Track failed login attempts
   - Monitor session creation/destruction
   - Set up alerts for suspicious activity

## Testing

See `AUTH_TESTING_CHECKLIST.md` for comprehensive manual testing instructions.

## Support

For issues or questions:

1. Check the troubleshooting section
2. Review the test checklist
3. Examine server logs for errors
4. Verify all environment variables are set correctly
