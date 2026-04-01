---
name: add-inngest-function
description: Scaffold a new Inngest function (event-driven, cron, or webhook-triggered) for the Mako workflow system. Use when creating background jobs, scheduled tasks, or event handlers.
---

# Add an Inngest Function

## Overview

Inngest functions are event-driven workflows that handle background processing, scheduled jobs, and webhook-triggered work. They live in `api/src/inngest/functions/` and are registered in `api/src/inngest/index.ts`.

## Steps

### 1. Create the function file

Create `api/src/inngest/functions/<name>.ts`:

```typescript
import { inngest } from "../client";
import { loggers } from "../../logging";

const log = loggers.inngest();

export const myFunction = inngest.createFunction(
  {
    id: "my-function",
    name: "My Function Description",
    retries: 3,
    concurrency: {
      limit: 1,
      key: "event.data.entityId",
    },
  },
  { event: "my/event.name" },
  async ({ event, step }) => {
    const { entityId, workspaceId } = event.data;

    // Step 1: Fetch data (idempotent, resumable on retry)
    const data = await step.run("fetch-data", async () => {
      log.info("Fetching data", { entityId, workspaceId });
      // ...
      return result;
    });

    // Step 2: Process data
    await step.run("process-data", async () => {
      log.info("Processing", { entityId, count: data.length });
      // ...
    });

    return { success: true };
  },
);
```

### 2. Register the function

Edit `api/src/inngest/index.ts` and add the function to the exports array:

```typescript
import { myFunction } from "./functions/my-function";

// Add to the functions array:
export const functions = [
  // ... existing functions
  myFunction,
];
```

### 3. Define the event type (optional but recommended)

If you want type-safe event payloads, add the event type to the Inngest client configuration in `api/src/inngest/client.ts`.

### 4. Trigger the function

```typescript
// From anywhere in the API:
import { inngest } from "../inngest/client";

await inngest.send({
  name: "my/event.name",
  data: { entityId: "123", workspaceId: "456" },
});
```

### 5. Test locally

1. `pnpm dev` starts the Inngest dev server at `http://localhost:8288`
2. Navigate to the Inngest dashboard to see registered functions
3. Trigger events manually from the dashboard or via API
4. Note: scheduler functions are disabled in development — trigger manually

## Trigger Types

### Event-driven

```typescript
{
  event: "flow.execute";
}
```

### Cron (scheduled)

```typescript
{
  cron: "0 */6 * * *";
} // Every 6 hours
```

### Cancellable (long-running)

```typescript
{
  id: "my-flow",
  cancelOn: [{ event: "flow.cancel", match: "data.flowId" }],
}
```

## Key Patterns

### Use `step.run` for every side effect

Each `step.run` is an idempotent checkpoint. If the function retries, completed steps are skipped.

### Use `step.sleep` for delays

```typescript
await step.sleep("wait-for-processing", "30s");
```

### Use `step.waitForEvent` for coordination

```typescript
const completion = await step.waitForEvent("wait-for-webhook", {
  event: "webhook/received",
  match: "data.flowId",
  timeout: "5m",
});
```

## Key Rules

- Always set `retries` explicitly — don't rely on Inngest defaults
- Always set `concurrency` with a `key` to prevent duplicate parallel runs
- Use `loggers.inngest()` for logging — never `console.log`
- Wrap every side-effectful operation in `step.run`
- Keep step names descriptive and unique within a function

## Reference Files

- Client: `api/src/inngest/client.ts`
- Function registry: `api/src/inngest/index.ts`
- Flow example: `api/src/inngest/functions/flow.ts`
- Dashboard refresh example: `api/src/inngest/functions/dashboard-refresh.ts`
- Inngest rules: `.cursor/rules/45-inngest.mdc`
