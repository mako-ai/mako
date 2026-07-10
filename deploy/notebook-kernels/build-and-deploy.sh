#!/usr/bin/env bash
#
# Build + push the kernel image and apply the k8s manifests. IDEMPOTENT:
# `docker push` is content-addressed and `kubectl apply` reconciles, so
# re-running only ships what changed.
#
# Run AFTER provision.sh, from anywhere:
#   PROJECT_ID=revops-462013 REGION=europe-west1 ./build-and-deploy.sh
#
# Prereqs: docker, gcloud (authenticated), kubectl with cluster credentials
#   gcloud container clusters get-credentials mako-notebooks --region <REGION>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
ARTIFACT_REPO="${ARTIFACT_REPO:-mako}"
IMAGE_NAME="${IMAGE_NAME:-notebook-kernel}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo latest)}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud default project is configured." >&2
  exit 1
fi

REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}"
export KERNEL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "→ Building kernel image ${KERNEL_IMAGE}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build \
  -f "${REPO_ROOT}/packages/kernel-image/Dockerfile" \
  -t "${KERNEL_IMAGE}" \
  "${REPO_ROOT}"

echo "→ Pushing image"
docker push "${KERNEL_IMAGE}"

echo "→ Applying manifests (namespace, quota, runtimeclass, policy, pool)"
kubectl apply -f "${SCRIPT_DIR}/k8s/namespace.yaml"
kubectl apply -f "${SCRIPT_DIR}/k8s/runtimeclass.yaml"
kubectl apply -f "${SCRIPT_DIR}/k8s/network-policy.yaml"
# Substitute ${KERNEL_IMAGE} into the pool spec before applying.
envsubst '${KERNEL_IMAGE}' < "${SCRIPT_DIR}/k8s/kernel-pool.yaml" | kubectl apply -f -

echo "→ Waiting for warm pool rollout"
kubectl -n mako-notebooks rollout status deployment/kernel-pool --timeout=180s

cat <<EOF

✅ Kernel image shipped and warm pool rolled out.
   Image: ${KERNEL_IMAGE}
   Pods : kubectl -n mako-notebooks get pods -l app.kubernetes.io/name=mako-kernel
EOF
