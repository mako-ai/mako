#!/bin/bash

# Exit on any error
set -e

source .env

# Use a different port for testing to avoid conflicts with local dev server
TEST_PORT=8090

# Override environment variables for production deployment
export BASE_URL="https://app.mako.ai"
export CLIENT_URL="https://app.mako.ai"  
export VITE_API_URL="https://app.mako.ai/api"

# Install dependencies
echo "Installing dependencies..."
if ! pnpm install --frozen-lockfile; then
  echo "❌ Dependency installation failed! Aborting deploy."
  exit 1
fi

# Run eslint before building - fail on errors, allow warnings
echo "Running ESLint checks..."
pnpm run --filter app lint
pnpm run --filter api lint

echo "ESLint checks passed. Proceeding with local build..."

# -------------------------------------------------------------
# Local verification step (build & quick start)
# -------------------------------------------------------------

# Attempt to build both front-end and API locally. If this fails, abort early.
echo "Building app and API with pnpm..."
if ! pnpm run build; then
  echo "❌ pnpm build failed! Aborting deploy."
  exit 1
fi

# Quickly start the API to ensure it boots up. Run in the background, wait a few seconds, then kill.
echo "Starting API locally to verify it starts..."
WEB_API_PORT=$TEST_PORT pnpm run api:start &
API_PID=$!

# Give the server a few seconds to initialise
sleep 7

# Check if the process is still running (i.e. the API did not crash)
if ! ps -p $API_PID > /dev/null; then
  echo "❌ API failed to start correctly. Check the logs above for details. Aborting deploy."
  exit 1
fi

# Stop the temporarily-started API process
kill $API_PID 2>/dev/null || true
wait $API_PID 2>/dev/null || true
echo "API startup verification succeeded."

# -------------------------------------------------------------
# Docker build & verification
# -------------------------------------------------------------

# Configure Docker authentication for Artifact Registry (only do this once)
# gcloud auth configure-docker $REGION-docker.pkg.dev

# Create repository (one-time setup) (only do this once)
# gcloud artifacts repositories create $REPO \
#   --repository-format=docker \
#   --location=$REGION

# Rebuild and redeploy (explicitly build for linux/amd64 platform)
echo "Building Docker image..."

# Create a temporary .env.production file for the build to pick up variables
echo "VITE_API_URL=$VITE_API_URL" > .env.production
echo "VITE_MUI_LICENSE_KEY=$VITE_MUI_LICENSE_KEY" >> .env.production

if ! docker build --platform linux/amd64 -t $IMAGE_NAME:latest .; then
    echo "❌ Docker build failed!"
    rm .env.production
    exit 1
fi
rm .env.production

# Verify that the freshly built image can start successfully.
echo "Testing Docker image locally..."
if ! docker run --rm -d --name revops_test -p $TEST_PORT:8080 $IMAGE_NAME:latest; then
    echo "❌ Docker container failed to start! Aborting deploy."
    exit 1
fi
# Give the container a few seconds to initialise
sleep 7
# Show recent logs for visibility
docker logs --tail 20 revops_test | cat
# Stop and remove the test container
docker stop revops_test || true
echo "Docker image verification succeeded."

echo "Tagging and pushing Docker image..."
docker tag $IMAGE_NAME:latest $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:latest
docker push $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:latest

# Create env.yaml by converting .env format to YAML format
# Convert KEY=value to KEY: "value" (quoted) and filter out empty lines and comments
# First output the overridden variables, then the rest from .env (excluding the overridden ones)
{
  echo "NODE_ENV: \"production\""
  echo "BASE_URL: \"$BASE_URL\""
  echo "CLIENT_URL: \"$CLIENT_URL\""
  echo "VITE_API_URL: \"$VITE_API_URL\""
  awk -F= '/^[^#]/ && NF==2 && $1!="NODE_ENV" && $1!="BASE_URL" && $1!="CLIENT_URL" && $1!="VITE_API_URL" {print $1": \""$2"\""}' .env
} > env.yaml

# Update Cloud Run service
gcloud run deploy mako \
  --image $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:latest \
  --region $REGION \
  --env-vars-file env.yaml \
  --min-instances=1 \
  --timeout=600

# -------------------------------------------------------------
# Run database migrations
# -------------------------------------------------------------
echo "Running database migrations..."
if ! pnpm run migrate; then
  echo "⚠️  Migrations failed! The deployment succeeded but migrations did not run."
  echo "    You may need to run 'pnpm run migrate' manually."
  exit 1
fi
echo "✅ Migrations completed successfully."

# Disable default run.app URL to force traffic through custom domain only (only do this once  )
# gcloud beta run services update revops-fullstack \
#   --region $REGION \
#   --no-default-url

# Verify domain ownership (only do this once)
# gcloud domains verify revops.realadvisor.com

# Add domain mapping (only do this once)
# gcloud beta run domain-mappings create \
#     --service=revops-fullstack \
#     --domain=revops.realadvisor.com \
#     --region=$REGION

# Add IAP policy
# gcloud run services add-iam-policy-binding revops-fullstack \
#     --region=$REGION \
#     --member="domain:revops.realadvisor.com" \
#     --role="roles/run.invoker" \