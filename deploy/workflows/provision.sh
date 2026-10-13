#!/usr/bin/env bash
#
# Provision Mako Workflows (Hatchet) on an existing notebook-kernels cluster.
# IDEMPOTENT: safe to re-run; it reconciles to the same state.
#
# Run once per environment, by someone with admin rights on the project:
#   PROJECT_ID=mako-ai-dev  ./provision.sh    # shared by all PR previews
#   PROJECT_ID=mako-ai-prod RUNTIME_SA=mako-runtime@mako-ai-prod.iam.gserviceaccount.com ./provision.sh
#
# Before the first run, the project's VPC needs private services access, which
# is how Cloud SQL gets a private address (once per project, network admin):
#   gcloud services enable sqladmin.googleapis.com servicenetworking.googleapis.com --project=$PROJECT_ID
#   gcloud compute addresses create google-managed-services-mako-vpc --project=$PROJECT_ID \
#     --global --purpose=VPC_PEERING --prefix-length=20 --network=mako-vpc
#   gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com \
#     --ranges=google-managed-services-mako-vpc --network=mako-vpc --project=$PROJECT_ID
#
# Creates:
#   - Cloud SQL Postgres instance `mako-hatchet` (private IP only), database and
#     user `hatchet`, and secret HATCHET_DATABASE_URL
#   - secret HATCHET_ADMIN_PASSWORD (generated once; the Mako API logs in with it)
#   - Helm release `hatchet` (hatchet/hatchet-stack 0.19.0) in namespace `hatchet`
#   - namespace `mako-workflows` + quota + egress lockdown for workflow workers
#   - Service `hatchet-api-internal`: an internal load balancer the Mako API calls
#
# Prereqs: gcloud (authenticated), kubectl, helm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID (mako-ai-dev or mako-ai-prod)}"
CLUSTER="${CLUSTER:-mako-notebooks}"
CLUSTER_LOCATION="${CLUSTER_LOCATION:-europe-west1-b}"
CHART_VERSION="0.19.0"
REGION="${REGION:-europe-west1}"
NETWORK="${NETWORK:-mako-vpc}"
SQL_INSTANCE="${SQL_INSTANCE:-mako-hatchet}"
# Hatchet holds many connections; the smallest shared-core tier allows too few.
SQL_TIER="${SQL_TIER:-db-g1-small}"

echo "→ Project=${PROJECT_ID} Cluster=${CLUSTER} (${CLUSTER_LOCATION})"
gcloud container clusters get-credentials "${CLUSTER}" \
  --location "${CLUSTER_LOCATION}" --project "${PROJECT_ID}"

# --- 1. Database ----------------------------------------------------------------
# Plain Postgres on Cloud SQL. Not Neon: Hatchet's outbox migrations choose
# their schema with the `search_path` connection parameter, which Neon drops,
# so on Neon the tables land in `public` and no run ever starts.
secret() { gcloud secrets versions access latest --secret="$1" --project="${PROJECT_ID}"; }

if gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "✓ Cloud SQL instance ${SQL_INSTANCE} exists"
else
  echo "→ Creating Cloud SQL instance ${SQL_INSTANCE} (about 10 minutes)"
  gcloud sql instances create "${SQL_INSTANCE}" --project "${PROJECT_ID}" \
    --database-version=POSTGRES_17 --edition=ENTERPRISE --tier="${SQL_TIER}" \
    --region="${REGION}" --no-assign-ip \
    --network="projects/${PROJECT_ID}/global/networks/${NETWORK}" \
    --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --database-flags=max_connections=200 --backup-start-time=03:00
fi
SQL_IP="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" \
  --format='value(ipAddresses[0].ipAddress)')"

gcloud sql databases describe hatchet --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud sql databases create hatchet --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null

# The URL holds the password, so the secret is the only place it is kept. A
# secret that does not point at this instance is replaced, with a new password.
DATABASE_URL="$(secret HATCHET_DATABASE_URL 2>/dev/null || true)"
if [[ "${DATABASE_URL}" != *"@${SQL_IP}:"* ]]; then
  echo "→ Creating database user and HATCHET_DATABASE_URL"
  DB_PASSWORD="$(openssl rand -hex 24)"
  if gcloud sql users list --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" \
    --format='value(name)' | grep -qx hatchet; then
    gcloud sql users set-password hatchet --instance "${SQL_INSTANCE}" \
      --project "${PROJECT_ID}" --password="${DB_PASSWORD}" >/dev/null
  else
    gcloud sql users create hatchet --instance "${SQL_INSTANCE}" \
      --project "${PROJECT_ID}" --password="${DB_PASSWORD}" >/dev/null
  fi
  DATABASE_URL="postgresql://hatchet:${DB_PASSWORD}@${SQL_IP}:5432/hatchet?sslmode=require"
  gcloud secrets describe HATCHET_DATABASE_URL --project "${PROJECT_ID}" >/dev/null 2>&1 \
    || gcloud secrets create HATCHET_DATABASE_URL --project "${PROJECT_ID}" \
      --replication-policy=automatic >/dev/null
  printf '%s' "${DATABASE_URL}" | gcloud secrets versions add HATCHET_DATABASE_URL \
    --data-file=- --project "${PROJECT_ID}" >/dev/null
else
  echo "✓ HATCHET_DATABASE_URL points at ${SQL_INSTANCE}"
fi

# --- 2. Secrets -----------------------------------------------------------------
if ! ADMIN_PASSWORD="$(secret HATCHET_ADMIN_PASSWORD 2>/dev/null)"; then
  echo "→ Generating HATCHET_ADMIN_PASSWORD"
  ADMIN_PASSWORD="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)Aa1!"
  printf '%s' "${ADMIN_PASSWORD}" | gcloud secrets create HATCHET_ADMIN_PASSWORD \
    --data-file=- --project="${PROJECT_ID}" >/dev/null
else
  echo "✓ HATCHET_ADMIN_PASSWORD exists"
fi

# The Mako API (Cloud Run) reads HATCHET_ADMIN_PASSWORD at runtime to create a
# tenant per workspace. Prod runs as a dedicated SA (set RUNTIME_SA); dev and
# previews run as the default compute SA, which Editor does not let read secrets.
RUNTIME_SA="${RUNTIME_SA:-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"
echo "→ Granting ${RUNTIME_SA} access to HATCHET_ADMIN_PASSWORD"
gcloud secrets add-iam-policy-binding HATCHET_ADMIN_PASSWORD --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" --condition=None --quiet >/dev/null

# --- 3. Hatchet -----------------------------------------------------------------
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

# --- 4. Workflow workers' namespace -------------------------------------------
echo "→ Applying mako-workflows namespace + network policy"
kubectl apply -f "${SCRIPT_DIR}/k8s/namespace.yaml"
kubectl apply -f "${SCRIPT_DIR}/k8s/network-policy.yaml"

# --- 5. In-VPC address for the Hatchet API ---------------------------------------
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
   Hatchet   : namespace hatchet, database on Cloud SQL ${SQL_INSTANCE}
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
