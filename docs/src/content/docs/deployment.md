---
title: Deployment
description: Deploy Mako to production with Docker, Google Cloud Run, or Cloudflare.
---

## Docker

Mako ships with a production-ready Dockerfile.

```bash
# Build the image
docker build -t mako .

# Run it
docker run -p 8080:8080 \
  -e DATABASE_URL=mongodb://your-mongodb-url/mako \
  -e ENCRYPTION_KEY=your-32-byte-hex-key \
  -e SESSION_SECRET=your-session-secret \
  -e OPENAI_API_KEY=your-openai-key \
  mako
```

The image bundles both the API and the pre-built React frontend. The API serves the frontend from `/public`.

### Docker Compose (Development)

```bash
# Start MongoDB + app
pnpm run docker:up

# Stop
pnpm run docker:down

# Clean (removes volumes)
pnpm run docker:clean
```

## Google Cloud Run

Mako includes a deploy script for Cloud Run:

```bash
# Runs lint, build, local verification, then deploys
./deploy.sh
```

The script:
1. Installs dependencies
2. Runs ESLint
3. Builds both app and API
4. Starts the API locally to verify it boots
5. Builds Docker image and pushes to Google Artifact Registry
6. Deploys to Cloud Run

### Environment Variables

Set these in Cloud Run's environment configuration (or via `cloud-run-env.yaml`):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | MongoDB connection string |
| `ENCRYPTION_KEY` | Yes | Credential encryption |
| `SESSION_SECRET` | Yes | Session security |
| `BASE_URL` | Yes | Public URL (e.g., `https://app.mako.ai`) |
| `CLIENT_URL` | Yes | Same as BASE_URL for Cloud Run |
| `OPENAI_API_KEY` | Recommended | AI features |
| `ANTHROPIC_API_KEY` | Optional | Anthropic models |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Optional | Google models |
| `GOOGLE_CLIENT_ID` + `SECRET` | Optional | Google OAuth |
| `GH_CLIENT_ID` + `SECRET` | Optional | GitHub OAuth |
| `SENDGRID_API_KEY` | Optional | Email invitations |

## Cloudflare Workers

The `cloudflare/` directory contains Cloudflare Workers configuration for edge routing and proxy functionality.
