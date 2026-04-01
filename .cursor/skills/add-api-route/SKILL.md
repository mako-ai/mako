---
name: add-api-route
description: Scaffold a new API route with proper auth, workspace scoping, and middleware chain for the Mako Hono backend. Use when adding new API endpoints.
---

# Add a New API Route

## Overview

API routes use Hono, follow a strict middleware ordering, and delegate business logic to the service layer.

## Steps

### 1. Create the route file

Create `api/src/routes/<feature>.ts`:

```typescript
import { Hono } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { workspaceService } from "../services/workspace.service";

const log = loggers.api("<feature>");

const routes = new Hono();

// Apply auth middleware to all routes
routes.use("*", unifiedAuthMiddleware);

// Workspace verification with defense-in-depth
routes.use("/:workspaceId/*", async (c, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
  } else {
    // CRITICAL: Defense in depth — reject if neither auth type succeeded
    return c.json({ error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

// Route handlers
routes.get("/:workspaceId/items", async c => {
  const workspaceId = c.req.param("workspaceId");
  try {
    // Delegate to service layer
    const result = await myService.getItems(workspaceId);
    return c.json({ data: result });
  } catch (error) {
    log.error("Failed to get items", { error, workspaceId });
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default routes;
```

### 2. Mount the route in the API index

Edit `api/src/index.ts`:

```typescript
import featureRoutes from "./routes/<feature>";

app.route("/api/<feature>", featureRoutes);
```

### 3. Create the service (if needed)

Create `api/src/services/<feature>.service.ts` with business logic. Routes should be thin — parameter parsing, auth, and delegating to services.

### 4. Test

1. Start dev server: `pnpm dev`
2. Test endpoints via the frontend or curl
3. Verify auth (session + API key) works
4. Verify workspace scoping is correct

## Middleware Chain (Required Order)

```
unifiedAuthMiddleware → workspace verification (with else clause) → route handler
```

## Key Rules

- **Always include the `else` clause** in workspace verification for defense in depth.
- Use `loggers.api("<feature>")` for route-specific logging. Never `console.log`.
- Call `enrichContextWithWorkspace()` only AFTER authorization succeeds.
- Validate inputs at the route boundary (Zod preferred).
- Return consistent error shapes with proper HTTP status codes.
- Keep route files minimal — delegate to services.

## Reference Files

- Auth middleware: `api/src/auth/unified-auth.middleware.ts`
- Auth rules: `.cursor/rules/30-auth.mdc`
- API routing rules: `.cursor/rules/20-api-routing.mdc`
- Existing example: `api/src/routes/consoles.ts`
