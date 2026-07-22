#!/usr/bin/env bash
#
# Provision the Mako Notebooks kernel plane on GCP. IDEMPOTENT: every step
# checks for existing state before creating, so it is safe to re-run.
#
# Creates, in your existing project/VPC (all guarded describe||create):
#   - reuses the existing Artifact Registry repo (revops) for the kernel image
#   - a dedicated subnet (mako-notebooks-subnet) + pod/service secondary ranges
#   - a GKE Standard cluster (Workload Identity on), VPC-native on that subnet
#   - a GKE Sandbox (gVisor) node pool for kernels — high-memory, CPU-only,
#     autoscaling to zero
#   - a GCS bucket for notebook outputs + kernel snapshots
#   - IAM so the kernel node service account can pull images + use the bucket
#
# Provisioned objects (revops-462013 / europe-west1):
#   subnet   mako-notebooks-subnet  10.200.0.0/24 (pods 10.201.0.0/16, svc 10.202.0.0/20)
#   cluster  mako-notebooks         zonal europe-west1-b (node pool: kernels, gVisor)
#   bucket   gs://revops-462013-notebook-artifacts
#   image    europe-west1-docker.pkg.dev/revops-462013/revops/notebook-kernel
#
# Usage:
#   PROJECT_ID=revops-462013 REGION=europe-west1 ./provision.sh
#
# Prereqs: gcloud (authenticated), and the caller has project admin rights.
set -euo pipefail

# --- Configuration (override via env) ---------------------------------------
# Defaults below reflect what is actually provisioned in revops-462013.
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
# Cluster location: a single zone (cheaper v1 — one-node system pool, one free
# zonal control plane per billing account). Set CLUSTER_LOCATION to the REGION
# to run a regional (HA) cluster instead; the subnet stays regional either way.
ZONE="${ZONE:-europe-west1-b}"
CLUSTER_LOCATION="${CLUSTER_LOCATION:-${ZONE}}"
NETWORK="${NETWORK:-mako-vpc}"
# Dedicated subnet for the kernel cluster, kept separate from the prod Cloud
# Run subnet `mako-subnet` so kernel pod/node IP churn never touches it. The
# secondary ranges below back the VPC-native cluster (pods + services). CIDRs
# chosen clear of the only in-use ranges in mako-vpc: 10.0.0.0/24 (mako-subnet)
# and 10.67.253.176/29 (managed-Redis peering).
KERNEL_SUBNET="${KERNEL_SUBNET:-mako-notebooks-subnet}"
KERNEL_SUBNET_RANGE="${KERNEL_SUBNET_RANGE:-10.200.0.0/24}"     # node IPs (primary)
KERNEL_PODS_RANGE="${KERNEL_PODS_RANGE:-10.201.0.0/16}"         # pod IPs (secondary "pods")
KERNEL_SERVICES_RANGE="${KERNEL_SERVICES_RANGE:-10.202.0.0/20}" # svc IPs (secondary "services")
CLUSTER="${CLUSTER:-mako-notebooks}"
KERNEL_NODE_POOL="${KERNEL_NODE_POOL:-kernels}"
KERNEL_MACHINE_TYPE="${KERNEL_MACHINE_TYPE:-e2-highmem-4}" # 4 vCPU / 32 GB
KERNEL_MIN_NODES="${KERNEL_MIN_NODES:-0}"
KERNEL_MAX_NODES="${KERNEL_MAX_NODES:-5}"
# Reuse the existing Artifact Registry repo (CI's GCP_ARTIFACT_REPOSITORY),
# not a new one — the kernel image is just another tag under it.
ARTIFACT_REPO="${ARTIFACT_REPO:-revops}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${PROJECT_ID}-notebook-artifacts}"
# The Cloud Run runtime service account (the control-plane `mako` service runs
# as this). It must reach the GKE cluster + the notebook bucket. Prod runs as a
# dedicated least-privilege SA (e.g. `mako-runtime@<project>.iam...`); dev/
# preview run as the default compute SA, which is already broad — so this is
# OPTIONAL and skipped with a note when unset.
RUNTIME_SA="${RUNTIME_SA:-}"
# Cloud Run's VPC-egress subnet — the SOURCE range for kernel ingress on :8888.
# (Distinct from KERNEL_SUBNET, which is the cluster's own subnet.)
CLOUD_RUN_SUBNET="${CLOUD_RUN_SUBNET:-mako-subnet}"

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

# --- 3. Dedicated subnet + secondary ranges (VPC-native cluster) ------------
if ! gcloud compute networks subnets describe "${KERNEL_SUBNET}" \
  --region="${REGION}" >/dev/null 2>&1; then
  echo "→ Creating subnet ${KERNEL_SUBNET} (nodes ${KERNEL_SUBNET_RANGE}, pods ${KERNEL_PODS_RANGE}, services ${KERNEL_SERVICES_RANGE})"
  gcloud compute networks subnets create "${KERNEL_SUBNET}" \
    --network="${NETWORK}" \
    --region="${REGION}" \
    --range="${KERNEL_SUBNET_RANGE}" \
    --secondary-range="pods=${KERNEL_PODS_RANGE},services=${KERNEL_SERVICES_RANGE}" \
    --enable-private-ip-google-access
else
  echo "✓ Subnet ${KERNEL_SUBNET} exists"
fi

# --- 4. GKE Standard cluster ------------------------------------------------
# Standard (not Autopilot): GKE Sandbox + the privileged bits a gVisor
# checkpoint/restore flow needs are not available on Autopilot. VPC-native,
# pinned to the dedicated subnet's secondary ranges.
if ! gcloud container clusters describe "${CLUSTER}" \
  --location="${CLUSTER_LOCATION}" >/dev/null 2>&1; then
  echo "→ Creating GKE Standard cluster ${CLUSTER} in ${CLUSTER_LOCATION} (this takes a few minutes)"
  gcloud container clusters create "${CLUSTER}" \
    --location="${CLUSTER_LOCATION}" \
    --network="${NETWORK}" \
    --subnetwork="${KERNEL_SUBNET}" \
    --workload-pool="${PROJECT_ID}.svc.id.goog" \
    --release-channel=regular \
    --enable-ip-alias \
    --cluster-secondary-range-name=pods \
    --services-secondary-range-name=services \
    --num-nodes=1 \
    --machine-type=e2-standard-2 \
    --enable-autoscaling --min-nodes=1 --max-nodes=2 \
    --no-enable-basic-auth --no-issue-client-certificate
else
  echo "✓ GKE cluster ${CLUSTER} exists"
fi

# --- 5. GKE Sandbox (gVisor) node pool for kernels --------------------------
# Untrusted notebook/agent code runs here: gVisor isolates it from the host,
# and the pool scales to zero when no notebooks are running.
if ! gcloud container node-pools describe "${KERNEL_NODE_POOL}" \
  --cluster="${CLUSTER}" --location="${CLUSTER_LOCATION}" >/dev/null 2>&1; then
  echo "→ Creating gVisor sandbox node pool ${KERNEL_NODE_POOL}"
  gcloud container node-pools create "${KERNEL_NODE_POOL}" \
    --cluster="${CLUSTER}" --location="${CLUSTER_LOCATION}" \
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

# --- 6. GCS bucket for notebook docs + outputs + snapshots ------------------
if ! gcloud storage buckets describe "gs://${ARTIFACT_BUCKET}" >/dev/null 2>&1; then
  echo "→ Creating GCS bucket ${ARTIFACT_BUCKET}"
  gcloud storage buckets create "gs://${ARTIFACT_BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access
else
  echo "✓ Bucket ${ARTIFACT_BUCKET} exists"
fi
# Object versioning keeps prior generations of notebook documents (the version-
# history feature reads them) and protects offloaded cell outputs from an
# accidental overwrite. Idempotent — enabling when already on is a no-op.
gcloud storage buckets update "gs://${ARTIFACT_BUCKET}" --versioning --quiet >/dev/null
echo "✓ Object versioning enabled on ${ARTIFACT_BUCKET}"

# --- 7. IAM: let the node service account read images + use the bucket ------
# Pools created without an explicit SA report "default"; in that case the nodes
# run as the Compute Engine default SA, derived from the project number.
NODE_SA="$(gcloud container clusters describe "${CLUSTER}" --location="${CLUSTER_LOCATION}" \
  --format='value(nodePools[0].config.serviceAccount)')"
if [[ "${NODE_SA}" == "default" || -z "${NODE_SA}" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  NODE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "→ Granting ${NODE_SA} artifact-read + bucket access (idempotent)"
gcloud artifacts repositories add-iam-policy-binding "${ARTIFACT_REPO}" \
  --location="${REGION}" \
  --member="serviceAccount:${NODE_SA}" \
  --role="roles/artifactregistry.reader" --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${ARTIFACT_BUCKET}" \
  --member="serviceAccount:${NODE_SA}" \
  --role="roles/storage.objectAdmin" --quiet >/dev/null

# --- 8. Cloud Run RUNTIME service account: reach GKE + the notebook bucket ---
# The control-plane `mako` service (Cloud Run) drives the kernel plane and owns
# the notebook store. Its runtime SA must (a) call the cluster's k8s API to
# spawn/scale kernels and (b) read/write the notebook bucket. This is a DIFFERENT
# SA from the node SA above. Prod runs as a dedicated least-privilege SA
# (RUNTIME_SA); dev/preview run as the default compute SA (already broad), so
# RUNTIME_SA is optional and skipped with a note when unset.
if [[ -n "${RUNTIME_SA}" ]]; then
  echo "→ Granting Cloud Run runtime SA ${RUNTIME_SA} GKE + bucket access (idempotent)"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/container.developer" --condition=None --quiet >/dev/null
  gcloud storage buckets add-iam-policy-binding "gs://${ARTIFACT_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/storage.objectAdmin" --quiet >/dev/null
else
  echo "! RUNTIME_SA not set — skipping Cloud Run runtime-SA grants."
  echo "  In prod, set RUNTIME_SA=<cloud-run-sa> to grant roles/container.developer"
  echo "  (spawn kernels) + roles/storage.objectAdmin on the bucket (notebook store)."
fi

# --- 9. Firewall: let Cloud Run reach kernel gateways on :8888 --------------
# Cloud Run egresses into ${NETWORK} via ${CLOUD_RUN_SUBNET}; kernel pods listen
# on :8888. Allow that specific path (the k8s NetworkPolicy is the second
# layer). The source is the Cloud Run subnet range; the target is the kernel
# cluster's node tag (GKE auto-tags nodes `gke-<cluster>-<hash>-node`).
FW_NAME="mako-notebooks-cr-to-kernels"
if gcloud compute firewall-rules describe "${FW_NAME}" >/dev/null 2>&1; then
  echo "✓ Firewall ${FW_NAME} exists"
else
  CR_RANGE="$(gcloud compute networks subnets describe "${CLOUD_RUN_SUBNET}" \
    --region="${REGION}" --format='value(ipCidrRange)' 2>/dev/null || true)"
  NODE_TAG="$(gcloud compute firewall-rules list \
    --filter="network=${NETWORK} AND name~^gke-${CLUSTER}-" \
    --format='value(targetTags[0])' 2>/dev/null | head -1)"
  if [[ -n "${CR_RANGE}" && -n "${NODE_TAG}" ]]; then
    echo "→ Creating firewall ${FW_NAME} (${CR_RANGE} → ${NODE_TAG}:8888)"
    gcloud compute firewall-rules create "${FW_NAME}" \
      --network="${NETWORK}" --direction=INGRESS --action=ALLOW \
      --rules=tcp:8888 --source-ranges="${CR_RANGE}" --target-tags="${NODE_TAG}"
  else
    echo "! Skipping ${FW_NAME}: could not resolve Cloud Run range (${CR_RANGE:-?})"
    echo "  or the kernel node tag (${NODE_TAG:-?}). Create it once the cluster exists."
  fi
fi

cat <<EOF

✅ Kernel plane provisioned.
   Cluster : ${CLUSTER} (${CLUSTER_LOCATION})
   Pool    : ${KERNEL_NODE_POOL} (gVisor, ${KERNEL_MACHINE_TYPE}, 0..${KERNEL_MAX_NODES})
   Registry: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}
   Bucket  : gs://${ARTIFACT_BUCKET}

Next:
   gcloud container clusters get-credentials ${CLUSTER} --location ${CLUSTER_LOCATION}
   PROJECT_ID=${PROJECT_ID} REGION=${REGION} ./build-and-deploy.sh
EOF
