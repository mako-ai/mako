#!/usr/bin/env bash
#
# Provision Mako Workflows (Hatchet) on an existing notebook-kernels cluster.
# IDEMPOTENT: safe to re-run; it reconciles to the same state.
#
# Run once per environment, by someone with admin rights on the project:
#   PROJECT_ID=mako-ai-dev  ./provision.sh    # shared by all PR previews
#   PROJECT_ID=mako-ai-prod RUNTIME_SA=mako-runtime@mako-ai-prod.iam.gserviceaccount.com ./provision.sh
#
# Before the first run, store Hatchet's Postgres URL (Neon, DIRECT endpoint —
# the host WITHOUT `-pooler`) in that project's Secret Manager:
#   printf '%s' 'postgresql://…@ep-xxx.<region>.aws.neon.tech/neondb?sslmode=require' |
#     gcloud secrets create HATCHET_DATABASE_URL --data-file=- --project=$PROJECT_ID
#
# Creates:
#   - secret HATCHET_ADMIN_PASSWORD (generated once; the Mako API logs in with it)
#   - Helm release `hatchet` (hatchet/hatchet-stack 0.19.0) in namespace `hatchet`
#   - namespace `mako-workflows` + quota + egress lockdown for workflow workers
#   - Service `hatchet-api-internal`: an internal load balancer the Mako API calls
#
# Prereqs: gcloud (authenticated), kubectl, helm, psql.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID (mako-ai-dev or mako-ai-prod)}"
CLUSTER="${CLUSTER:-mako-notebooks}"
CLUSTER_LOCATION="${CLUSTER_LOCATION:-europe-west1-b}"
CHART_VERSION="0.19.0"

echo "→ Project=${PROJECT_ID} Cluster=${CLUSTER} (${CLUSTER_LOCATION})"
gcloud container clusters get-credentials "${CLUSTER}" \
  --location "${CLUSTER_LOCATION}" --project "${PROJECT_ID}"

# --- 1. Secrets ---------------------------------------------------------------
secret() { gcloud secrets versions access latest --secret="$1" --project="${PROJECT_ID}"; }

if ! DATABASE_URL="$(secret HATCHET_DATABASE_URL 2>/dev/null)"; then
  echo "✗ Secret HATCHET_DATABASE_URL missing in ${PROJECT_ID} (see header)." >&2
  exit 1
fi
if [[ "${DATABASE_URL}" == *"-pooler."* ]]; then
  echo "✗ HATCHET_DATABASE_URL uses Neon's pooled endpoint; Hatchet needs the direct one (drop '-pooler')." >&2
  exit 1
fi

if ! ADMIN_PASSWORD="$(secret HATCHET_ADMIN_PASSWORD 2>/dev/null)"; then
  echo "→ Generating HATCHET_ADMIN_PASSWORD"
  ADMIN_PASSWORD="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)Aa1!"
  printf '%s' "${ADMIN_PASSWORD}" | gcloud secrets create HATCHET_ADMIN_PASSWORD \
    --data-file=- --project="${PROJECT_ID}" >/dev/null
else
  echo "✓ HATCHET_ADMIN_PASSWORD exists"
fi

# Hatchet's seed job refuses to start unless the database timezone is UTC, and
# Neon databases default to GMT.
echo "→ Setting Hatchet database timezone to UTC"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -c \
  "DO \$\$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database()); END \$\$;"

# The Mako API (Cloud Run) reads HATCHET_ADMIN_PASSWORD at runtime to create a
# tenant per workspace. Prod runs as a dedicated SA (set RUNTIME_SA); dev and
# previews run as the default compute SA, which Editor does not let read secrets.
RUNTIME_SA="${RUNTIME_SA:-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"
echo "→ Granting ${RUNTIME_SA} access to HATCHET_ADMIN_PASSWORD"
gcloud secrets add-iam-policy-binding HATCHET_ADMIN_PASSWORD --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" --condition=None --quiet >/dev/null

# --- 2. Hatchet -----------------------------------------------------------------
echo "→ Installing Hatchet (chart ${CHART_VERSION})"
helm repo add hatchet https://hatchet-dev.github.io/hatchet-charts >/dev/null 2>&1 || true
helm repo update hatchet >/dev/null
helm upgrade --install hatchet hatchet/hatchet-stack \
  --version "${CHART_VERSION}" \
  --namespace hatchet --create-namespace \
  -f "${SCRIPT_DIR}/hatchet-values.yaml" \
  --set-string "sharedConfig.defaultAdminPassword=${ADMIN_PASSWORD}" \
  --set-string "sharedConfig.env.DATABASE_URL=${DATABASE_URL}" \
  --wait --timeout 15m

# The Mako API and worker manifests assume these service names.
for svc in hatchet-api hatchet-engine; do
  kubectl -n hatchet get svc "${svc}" >/dev/null \
    || { echo "✗ Expected service hatchet/${svc} not found; update hatchet-values.yaml and the API." >&2; exit 1; }
done
echo "✓ Hatchet running"

# --- 3. Workflow workers' namespace -------------------------------------------
echo "→ Applying mako-workflows namespace + network policy"
kubectl apply -f "${SCRIPT_DIR}/k8s/namespace.yaml"
kubectl apply -f "${SCRIPT_DIR}/k8s/network-policy.yaml"

# --- 4. In-VPC address for the Hatchet API ---------------------------------------
kubectl apply -f "${SCRIPT_DIR}/k8s/hatchet-api-internal.yaml"
echo "→ Waiting for the internal load balancer address"
HATCHET_IP=""
for _ in $(seq 1 60); do
  HATCHET_IP="$(kubectl -n hatchet get svc hatchet-api-internal \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  [[ -n "${HATCHET_IP}" ]] && break
  sleep 5
done
[[ -n "${HATCHET_IP}" ]] || { echo "✗ No address for hatchet-api-internal after 5 minutes." >&2; exit 1; }

cat <<EOF

✅ Mako Workflows provisioned in ${PROJECT_ID}.
   Hatchet   : namespace hatchet, DB from HATCHET_DATABASE_URL
   Workers   : namespace mako-workflows (gVisor, egress locked)
   Dashboard : kubectl -n hatchet port-forward svc/caddy 8080:8080
               login workflows-admin@mako.ai / secret HATCHET_ADMIN_PASSWORD

The Mako API needs (Cloud Run):
   HATCHET_API_URL              http://${HATCHET_IP}:8080
   HATCHET_ADMIN_PASSWORD       --set-secrets HATCHET_ADMIN_PASSWORD=HATCHET_ADMIN_PASSWORD:latest
   HATCHET_CLIENT_TLS_STRATEGY  none   (this Hatchet's gRPC port has no TLS)
   WORKFLOWS_RUNTIME_IMAGE      the workflows-runtime image in this project's registry
   WORKFLOWS_NAME_PREFIX        previews only: pr-<n>-
The cluster endpoint/CA are the existing KERNEL_GKE_* values.
EOF
