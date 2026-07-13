# Mako production app router

This dedicated Worker keeps `app.mako.ai` independent of a Cloud Run project.
It proxies request and response streams without buffering and supports a
maintenance mode that continues accepting external webhooks.

It reuses the existing `MAKO_PR_DEPLOYMENTS` KV namespace under a separate
binding and reserved key prefix:

- `route:app.mako.ai`
- `route:app-canary.mako.ai`

Each value is one JSON object so an individual Cloudflare PoP cannot observe a
new origin with stale maintenance state:

```json
{"origin":"https://mako-PROJECT_HASH-ew.a.run.app","maintenance":false}
```

Workers KV propagates globally rather than atomically. During cutover, old and
new PoPs may briefly use different complete route objects. This is safe only
while the Inngest app is archived and both origins persist webhooks to the same
database.

The Worker secret `MAINTENANCE_BYPASS_TOKEN` enables operator requests carrying
the `X-Mako-Maintenance-Token` header. Never store this token in KV or git.

## Validation

```bash
node --test cloudflare/app-router/worker.test.mjs
npx wrangler@4.110.0 deploy \
  --config cloudflare/app-router/wrangler.jsonc \
  --dry-run
npx wrangler@4.110.0 deploy \
  --config cloudflare/app-router/wrangler.canary.jsonc \
  --dry-run
```

## Cutover controls

```bash
# Route production to an origin.
npx wrangler@4.110.0 kv key put \
  --remote \
  --namespace-id 4b7600c488094db88540a401e8fbbce1 \
  "route:app.mako.ai" \
  '{"origin":"https://mako-PROJECT_HASH-ew.a.run.app","maintenance":false}'

# Route canary traffic without claiming the production route.
npx wrangler@4.110.0 kv key put \
  --remote \
  --namespace-id 4b7600c488094db88540a401e8fbbce1 \
  "route:app-canary.mako.ai" \
  '{"origin":"https://mako-canary-PROJECT_HASH-ew.a.run.app","maintenance":false}'

# Enter/exit maintenance while webhook endpoints remain available.
npx wrangler@4.110.0 kv key put \
  --remote \
  --namespace-id 4b7600c488094db88540a401e8fbbce1 \
  "route:app.mako.ai" \
  '{"origin":"https://mako-PROJECT_HASH-ew.a.run.app","maintenance":true}'
npx wrangler@4.110.0 kv key put \
  --remote \
  --namespace-id 4b7600c488094db88540a401e8fbbce1 \
  "route:app.mako.ai" \
  '{"origin":"https://mako-PROJECT_HASH-ew.a.run.app","maintenance":false}'
```

Deploy `wrangler.canary.jsonc` first; it cannot claim production traffic.
Deploy `wrangler.jsonc` only after `route:app.mako.ai` points at the verified
old production origin and has propagated.

Rollback is a route-object update to the previous Cloud Run URL. Inngest is
not routed through this Worker; it remains registered against the direct
`run.app/api/inngest` endpoint.
