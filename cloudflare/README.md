# Cloudflare Worker for PR Preview Routing

This worker routes requests from `pr-{number}.mako.ai` to the corresponding Cloud Run preview deployment.

## Setup Instructions

### 1. Login to Cloudflare

```bash
pnpm run cf:login
```

### 2. Create KV Namespace

```bash
pnpm run cf:kv:create
```

Copy the returned namespace ID and update `cloudflare/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MAKO_PR_DEPLOYMENTS"
id = "your-namespace-id-here"
```

### 3. Configure DNS in Cloudflare Dashboard

1. Go to Cloudflare Dashboard → DNS → Records
2. Add a wildcard CNAME record:
   - **Type**: CNAME
   - **Name**: `*.dev-app`
   - **Target**: Your worker route (or use Workers Routes)
   - **Proxy status**: Proxied (orange cloud)

Alternatively, set up Workers Routes:

1. Go to Workers & Pages → your worker → Settings → Triggers
2. Add Route: `pr-*.mako.ai/*` for zone `mako.ai`

### 4. Deploy the Worker

```bash
pnpm run cf:deploy
```

### 5. Test the Setup

```bash
# Store a test entry in KV (replace YOUR_NAMESPACE_ID)
pnpm exec wrangler kv:key put --namespace-id=YOUR_NAMESPACE_ID "123" "https://your-cloud-run-url.run.app"

# Test the routing
curl https://pr-123.mako.ai/
```

## How It Works

1. Request arrives at `pr-{number}.mako.ai`
2. Worker extracts the PR number from the subdomain
3. Worker looks up the Cloud Run URL from KV using the PR number as key
4. Worker proxies the request to Cloud Run, rewriting headers appropriately
5. Response is returned to the client with redirect URLs rewritten

## KV Entry Format

The GitHub workflow stores entries like:

- **Key**: `123` (PR number)
- **Value**: `https://mako-pr-123-abc123xyz.us-central1.run.app` (Cloud Run URL)

## Debugging

View worker logs:

```bash
pnpm run cf:tail
```

List KV entries:

```bash
# Set the namespace ID first
export CLOUDFLARE_KV_NAMESPACE_ID=your-namespace-id
pnpm run cf:kv:list
```

Get a specific entry:

```bash
pnpm exec wrangler kv:key get --namespace-id=YOUR_NAMESPACE_ID "123"
```

## GitHub Actions Integration

The GitHub workflow interacts with KV using the Cloudflare API:

```bash
# Store URL (done by deploy workflow)
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${PR_NUMBER}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: text/plain" \
  --data "${CLOUD_RUN_URL}"

# Delete URL (done by cleanup workflow)
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${PR_NUMBER}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

## Required GitHub Secrets

Add these to your GitHub repository:

- `CLOUDFLARE_API_TOKEN`: API token with Workers KV edit permissions
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
- `CLOUDFLARE_KV_NAMESPACE_ID`: The KV namespace ID for PR deployments

## NPM Scripts Reference

| Script                  | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm run cf:login`     | Login to Cloudflare                                         |
| `pnpm run cf:deploy`    | Deploy the worker                                           |
| `pnpm run cf:tail`      | View live worker logs                                       |
| `pnpm run cf:kv:create` | Create the KV namespace                                     |
| `pnpm run cf:kv:list`   | List KV entries (requires `CLOUDFLARE_KV_NAMESPACE_ID` env) |

## Preview Database Management

For ephemeral databases created when PRs have migration changes:

| Script                                   | Description                     |
| ---------------------------------------- | ------------------------------- |
| `pnpm run preview-db:list`               | List all ephemeral PR databases |
| `pnpm run preview-db:create <pr_number>` | Create ephemeral database       |
| `pnpm run preview-db:delete <pr_number>` | Delete ephemeral database       |

Requires `STAGING_DATABASE_URL` environment variable to be set.
