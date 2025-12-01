---
title: Authentication
description: How authentication works in Mako.
---

Mako uses a robust authentication system built with **Lucia Auth** and **Arctic**.

## Overview

- **Session Management**: Lucia Auth (v3) with MongoDB adapter.
- **OAuth**: Arctic for handling Google and GitHub flows.
- **Security**: HTTP-only cookies, CSRF protection, and rate limiting.

## Features

- **Email/Password**: Secure registration and login with bcrypt hashing.
- **Social Login**: "Continue with Google" and "Continue with GitHub".
- **Session Persistence**: Configurable session duration (default 24h).

## Integration Guide

### Protecting API Routes

Use the `unifiedAuthMiddleware` to protect API endpoints. It supports both Session cookies (for the Web App) and API Keys (for machine access).

```typescript
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";

app.get("/api/protected-resource", unifiedAuthMiddleware, c => {
  const user = c.get("user");
  return c.json({ message: `Hello, ${user.email}` });
});
```

### Frontend Usage

The frontend provides an `AuthProvider` and `useAuth` hook.

```tsx
import { useAuth } from "../hooks/useAuth";

const MyComponent = () => {
  const { user, isLoading } = useAuth();

  if (isLoading) return <div>Loading...</div>;
  if (!user) return <div>Please log in</div>;

  return <h1>Welcome, {user.email}</h1>;
};
```

## Configuration

Authentication settings are managed in `.env`:

```bash
# Session Security
SESSION_SECRET="super-secret-32-char-string"
SESSION_DURATION=86400000

# OAuth Providers
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
```
