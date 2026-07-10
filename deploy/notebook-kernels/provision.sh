#!/usr/bin/env bash
#
# Provision the Mako Notebooks kernel plane on GCP. IDEMPOTENT: every step
# checks for existing state before creating, so it is safe to re-run.
#
# Creates, in your existing project/VPC:
#   - Artifact Registry repo for the kernel image
#   - a GKE Standard cluster (Workload Identity on)
#   - a GKE Sandbox (gVisor) node pool for kernels — high-memory, CPU-only,
#     autoscaling to zero
#   - a GCS bucket for notebook outputs + kernel snapshots
#   - IAM so the kernel node service account can pull images + use the bucket
#
# Usage:
#   PROJECT_ID=revops-462013 REGION=europe-west1 ./provision.sh
#
# Prereqs: gcloud (authenticated), and the caller has project admin rights.
set -euo pipefail

# --- Configuration (override via env) ---------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
NETWORK="${NETWORK:-mako-vpc}"
SUBNET="${SUBNET:-mako-subnet}"
CLUSTER="${CLUSTER:-mako-notebooks}"
KERNEL_NODE_POOL="${KERNEL_NODE_POOL:-kernels}"
KERNEL_MACHINE_TYPE="${KERNEL_MACHINE_TYPE:-e2-highmem-4}" # 4 vCPU / 32 GB
KERNEL_MIN_NODES="${KERNEL_MIN_NODES:-0}"
KERNEL_MAX_NODES="${KERNEL_MAX_NODES:-5}"
ARTIFACT_REPO="${ARTIFACT_REPO:-mako}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${PROJECT_ID}-notebook-artifacts}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud default project is configured." >&2
  exit 1
fi

echo "→ Project=${PROJECT_ID} Region=${REGION} Cluster=${CLUSTER}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# --- 1. Enable APIs (enabling an already-enabled API is a no-op) -------------
echo "→ Enabling required APIs"
gcloud services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  --project "${PROJECT_ID}"

# --- 2. Artifact Registry repo for the kernel image -------------------------
if ! gcloud artifacts repositories describe "${ARTIFACT_REPO}" \
  --location="${REGION}" >/dev/null 2>&1; then
  echo "→ Creating Artifact Registry repo ${ARTIFACT_REPO}"
  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --repository-format=docker --location="${REGION}" \
    --description="Mako container images"
else
  echo "✓ Artifact Registry repo ${ARTIFACT_REPO} exists"
fi

# --- 3. GKE Standard cluster ------------------------------------------------
# Standard (not Autopilot): GKE Sandbox + the privileged bits a gVisor
# checkpoint/restore flow needs are not available on Autopilot.
if ! gcloud container clusters describe "${CLUSTER}" \
  --region="${REGION}" >/dev/null 2>&1; then
  echo "→ Creating GKE Standard cluster ${CLUSTER} (this takes a few minutes)"
  gcloud container clusters create "${CLUSTER}" \
    --region="${REGION}" \
    --network="${NETWORK}" \
    --subnetwork="${SUBNET}" \
    --workload-pool="${PROJECT_ID}.svc.id.goog" \
    --release-channel=regular \
    --enable-ip-alias \
    --num-nodes=1 \
    --machine-type=e2-standard-2 \
    --enable-autoscaling --min-nodes=1 --max-nodes=2 \
    --no-enable-basic-auth --no-issue-client-certificate
else
  echo "✓ GKE cluster ${CLUSTER} exists"
fi

# --- 4. GKE Sandbox (gVisor) node pool for kernels --------------------------
# Untrusted notebook/agent code runs here: gVisor isolates it from the host,
# and the pool scales to zero when no notebooks are running.
if ! gcloud container node-pools describe "${KERNEL_NODE_POOL}" \
  --cluster="${CLUSTER}" --region="${REGION}" >/dev/null 2>&1; then
  echo "→ Creating gVisor sandbox node pool ${KERNEL_NODE_POOL}"
  gcloud container node-pools create "${KERNEL_NODE_POOL}" \
    --cluster="${CLUSTER}" --region="${REGION}" \
    --machine-type="${KERNEL_MACHINE_TYPE}" \
    --image-type=cos_containerd \
    --sandbox type=gvisor \
    --enable-autoscaling \
    --num-nodes=0 --min-nodes="${KERNEL_MIN_NODES}" --max-nodes="${KERNEL_MAX_NODES}" \
    --node-labels=mako.ai/pool=kernels \
    --node-taints=mako.ai/kernels=true:NoSchedule
else
  echo "✓ Node pool ${KERNEL_NODE_POOL} exists"
fi

# --- 5. GCS bucket for outputs + snapshots ----------------------------------
if ! gcloud storage buckets describe "gs://${ARTIFACT_BUCKET}" >/dev/null 2>&1; then
  echo "→ Creating GCS bucket ${ARTIFACT_BUCKET}"
  gcloud storage buckets create "gs://${ARTIFACT_BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access
else
  echo "✓ Bucket ${ARTIFACT_BUCKET} exists"
fi

# --- 6. IAM: let the node service account read images + use the bucket ------
NODE_SA="$(gcloud container clusters describe "${CLUSTER}" --region="${REGION}" \
  --format='value(nodeConfig.serviceAccount)')"
[[ "${NODE_SA}" == "default" || -z "${NODE_SA}" ]] && NODE_SA="$(gcloud iam service-accounts list \
  --filter='displayName:Compute Engine default service account' \
  --format='value(email)' | head -n1)"
echo "→ Granting ${NODE_SA} artifact-read + bucket access (idempotent)"
gcloud artifacts repositories add-iam-policy-binding "${ARTIFACT_REPO}" \
  --location="${REGION}" \
  --member="serviceAccount:${NODE_SA}" \
  --role="roles/artifactregistry.reader" --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${ARTIFACT_BUCKET}" \
  --member="serviceAccount:${NODE_SA}" \
  --role="roles/storage.objectAdmin" --quiet >/dev/null

cat <<EOF

✅ Kernel plane provisioned.
   Cluster : ${CLUSTER} (${REGION})
   Pool    : ${KERNEL_NODE_POOL} (gVisor, ${KERNEL_MACHINE_TYPE}, 0..${KERNEL_MAX_NODES})
   Registry: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}
   Bucket  : gs://${ARTIFACT_BUCKET}

Next:
   gcloud container clusters get-credentials ${CLUSTER} --region ${REGION}
   PROJECT_ID=${PROJECT_ID} REGION=${REGION} ./build-and-deploy.sh
EOF
