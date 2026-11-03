#!/usr/bin/env bash
# Print the workflows runtime image to run, for WORKFLOWS_RUNTIME_IMAGE.
#
# The image is tagged by the git tree of deploy/workflows/runtime
# (workflows-runtime-image.yml), so its name changes exactly when the runtime
# does. The API compares that name with each worker's and moves workers to it
# when it starts (api/src/workflows/kube.ts). A `:latest` name never changes,
# so workers would never move.
#
# The image is built by its own workflow on the same push: wait for it. If it
# never comes (that build failed), fall back to `:latest` with a warning.
#
# Usage: resolve-runtime-image.sh <registry>/workflows-runtime [wait-seconds]
set -euo pipefail

REPOSITORY="$1"
WAIT_SECONDS="${2:-900}"
TREE=$(git rev-parse HEAD:deploy/workflows/runtime)
IMAGE="${REPOSITORY}:runtime-${TREE}"

deadline=$((SECONDS + WAIT_SECONDS))
until gcloud artifacts docker images describe "${IMAGE}" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "::warning title=Workflows runtime image missing::${IMAGE} was not published within ${WAIT_SECONDS}s; workers run ${REPOSITORY}:latest instead." >&2
    echo "${REPOSITORY}:latest"
    exit 0
  fi
  echo "Waiting for ${IMAGE}..." >&2
  sleep 15
done
echo "${IMAGE}"
