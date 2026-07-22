# Mako Notebooks — kernel plane (Infrastructure as Code)

Idempotent GCP provisioning + kubernetes manifests for the **stateful Python
kernel plane** that backs Mako notebooks. The control plane stays on Cloud Run
(the `mako` service); this stands up the GKE cluster that runs untrusted
notebook/agent code under gVisor.

> These scripts use plain `gcloud`/`kubectl` (matching Mako's existing
> `deploy.sh` conventions), not Terraform. Every step is guarded with
> `describe || create`, so re-running is safe.

## What gets created

| Resource | Name (default) | Purpose |
|---|---|---|
| Artifact Registry repo | `mako` | hosts the `notebook-kernel` image |
| GKE Standard cluster | `mako-notebooks` | kernel substrate (Workload Identity, Dataplane V2) |
| gVisor node pool | `kernels` | high-mem, CPU-only, autoscales `0..5`, `runsc` sandbox |
| GCS bucket | `<project>-notebook-artifacts` | notebook **documents** + outputs + snapshots |
| Bucket object versioning | on that bucket | version history + overwrite protection |
| IAM bindings — node SA | `<projnum>-compute@…` | pull images + read/write the bucket |
| IAM bindings — **runtime SA** | `RUNTIME_SA` (prod) | `container.developer` (spawn kernels) + bucket `objectAdmin` |
| Firewall | `mako-notebooks-cr-to-kernels` | Cloud Run subnet → kernel nodes `:8888` |
| k8s namespace | `mako-notebooks` | quota + limits + warm pool + egress policy |

> **These are the only out-of-repo account changes the notebook feature needs.**
> `provision.sh` applies them all idempotently, so the account state is tracked
> here rather than living only in someone's shell history. See
> [Out-of-band account changes](#out-of-band-account-changes) for the exact
> per-environment values.

## Prerequisites

- `gcloud` authenticated with project-admin rights on the target project
- `docker`, `kubectl`, and `envsubst` (from `gettext`) on your PATH
- The existing `mako-vpc` / `mako-subnet` network (same one Cloud Run egresses through)

## Run order

```bash
cd deploy/notebook-kernels

# 1. Provision cloud resources (cluster, pool, bucket + versioning, registry,
#    node-SA IAM, runtime-SA IAM, firewall). Pass RUNTIME_SA in prod.
PROJECT_ID=mako-ai-prod REGION=europe-west1 \
  RUNTIME_SA=mako-runtime@mako-ai-prod.iam.gserviceaccount.com ./provision.sh

# 2. Point kubectl at the new cluster (zonal — use --location).
gcloud container clusters get-credentials mako-notebooks --location europe-west1-b

# 3. Build + push the kernel image and apply manifests.
PROJECT_ID=mako-ai-prod REGION=europe-west1 ./build-and-deploy.sh
```

> Environments: **`mako-ai-dev`** (PR previews) and **`mako-ai-prod`**
> (production), both in `europe-west1`. Dev can omit `RUNTIME_SA` (its Cloud Run
> runs as the already-broad default compute SA).

## Configuration (env vars, all optional)

| Var | Default | Used by |
|---|---|---|
| `PROJECT_ID` | `gcloud config` project | both |
| `REGION` | `europe-west1` | both |
| `NETWORK` / `SUBNET` | `mako-vpc` / `mako-subnet` | provision |
| `CLUSTER` | `mako-notebooks` | provision |
| `KERNEL_NODE_POOL` | `kernels` | provision |
| `KERNEL_MACHINE_TYPE` | `e2-highmem-4` (4 vCPU / 32 GB) | provision |
| `KERNEL_MIN_NODES` / `KERNEL_MAX_NODES` | `0` / `5` | provision |
| `ARTIFACT_REPO` | `mako` | both |
| `ARTIFACT_BUCKET` | `<project>-notebook-artifacts` | provision |
| `RUNTIME_SA` | _(unset → skipped)_ | provision — Cloud Run runtime SA to grant (prod) |
| `CLOUD_RUN_SUBNET` | `mako-subnet` | provision — Cloud Run egress subnet (firewall source) |
| `IMAGE_NAME` | `notebook-kernel` | build-and-deploy |
| `IMAGE_TAG` | current git short SHA | build-and-deploy |

## Out-of-band account changes

Everything the notebook feature needs beyond application code and k8s manifests
— the GCP **account** mutations — is applied idempotently by `provision.sh`.
This is the record of *what*, *why*, and the exact per-environment values, so no
change lives only in someone's shell history.

| Change | Command (idempotent) | dev (`mako-ai-dev`) | prod (`mako-ai-prod`) |
|---|---|---|---|
| Bucket object versioning | `storage buckets update gs://<bucket> --versioning` | `mako-ai-dev-notebook-artifacts` | `mako-ai-prod-notebook-artifacts` |
| Runtime SA → GKE | `projects add-iam-policy-binding <proj> --role=roles/container.developer` | default compute SA _(already broad)_ | `mako-runtime@mako-ai-prod.iam.gserviceaccount.com` |
| Runtime SA → bucket | `storage buckets add-iam-policy-binding gs://<bucket> --role=roles/storage.objectAdmin` | default compute SA _(already broad)_ | `mako-runtime@…` |
| Node SA → registry + bucket | `add-iam-policy-binding … artifactregistry.reader` + `storage.objectAdmin` | `<projnum>-compute@…` | `<projnum>-compute@…` |
| Firewall CR → kernels:8888 | `compute firewall-rules create mako-notebooks-cr-to-kernels …` | src `10.10.0.0/20` | src `10.0.0.0/24` |

**Why dev needs no runtime-SA grants:** dev previews run Cloud Run as the
*default compute SA*, which carries `roles/editor` — already covering GKE +
bucket access. Prod runs as the dedicated least-privilege `mako-runtime@` SA, so
each capability is an explicit grant. (That mismatch is exactly what caused the
first prod notebook use to fail with `storage.objects.list denied` and a GKE
`403` until the grants were added.)

Re-apply for an environment (safe to re-run — every step is idempotent):

```bash
# prod — pass the dedicated runtime SA
PROJECT_ID=mako-ai-prod REGION=europe-west1 \
  RUNTIME_SA=mako-runtime@mako-ai-prod.iam.gserviceaccount.com \
  ./provision.sh

# dev — runtime SA is already broad, so RUNTIME_SA is optional
PROJECT_ID=mako-ai-dev REGION=europe-west1 ./provision.sh
```

### Related settings already tracked in the repo

For completeness — these live in version control, not in this out-of-band list:

- **`NOTEBOOK_KERNEL_API_URL`** — set by `.github/workflows/deploy-app.yml` to
  the service's **direct `run.app` URL**, so kernel pods reach the API bypassing
  Cloudflare (which `1010`-blocks their non-browser requests from GCP IPs).
- **`KERNEL_PROVIDER` / `KERNEL_GKE_ENDPOINT` / `KERNEL_GKE_CA_CERT` /
  `NOTEBOOK_GCS_BUCKET` / `REDIS_URL`** — Cloud Run env, set in the deploy
  workflow from repo vars/secrets. `REDIS_URL` also backs the durable kernel
  session registry (`api/src/services/kernel-session-store.ts`).

## Security posture (baked into the manifests)

- **gVisor** (`runtimeClassName: gvisor`) — user/agent code runs in a syscall
  sandbox, pinned to the `kernels` node pool via nodeSelector + taint toleration.
- **No credentials on kernels** — pods carry only `MAKO_API_URL`; SQL reads
  proxy through the control plane using a short-lived, read-only kernel token
  minted per session (`api/src/services/kernel-token.service.ts`).
- **Egress lockdown** (`network-policy.yaml`) — deny-by-default; only DNS +
  outbound `:443` to the API are allowed, and RFC1918 + the GCP metadata server
  (`169.254.169.254`) are explicitly blocked. Requires Dataplane V2 (default on
  the cluster this script creates).
- **Hardened container** — non-root (UID 1000), `readOnlyRootFilesystem`, all
  Linux capabilities dropped, `emptyDir` scratch with size limits.
- **Bounded** — `ResourceQuota` + `LimitRange` cap the whole namespace; per-pod
  `resources.limits` cap each kernel.

## Kernel image

`packages/kernel-image/Dockerfile` — `python:3.11-slim` + Jupyter Kernel Gateway
+ ipykernel + the analytics stack (`pandas`, `polars`, `pyarrow`, `numpy`,
`matplotlib`, `plotly`, `duckdb`) + the `mako` SDK (`packages/mako-sdk-py`),
pre-imported on boot. Served on `:8888`; the control plane connects, the browser
never does.

## How the control plane uses this

The `KernelProvider` GKE implementation (`api/src/services/kernel-provider/`)
claims a ready pod from the `kernel-pool` Deployment via the k8s API (scaling it
up from zero when cold), mints a read-only kernel token, and drives execution
over the gateway. Warm-pool `replicas` trade always-on cost for sub-5s starts;
the autoscaler grows the `kernels` pool to fit demand.

To turn it on, the Cloud Run `mako` service needs:

**IAM** — the runtime SA needs `roles/container.developer` (call the k8s API to
spawn/scale kernels) and `roles/storage.objectAdmin` on the notebook bucket.
`provision.sh` applies both when `RUNTIME_SA` is set — see
[Out-of-band account changes](#out-of-band-account-changes).

**Env** — set by `.github/workflows/deploy-app.yml` from repo vars/secrets:

```bash
KERNEL_PROVIDER=gke
KERNEL_GKE_ENDPOINT=<vars.KERNEL_GKE_ENDPOINT>   # the cluster's API endpoint
KERNEL_GKE_CA_CERT=<vars.KERNEL_GKE_CA_CERT>     # base64 cluster CA
NOTEBOOK_GCS_BUCKET=<vars.NOTEBOOK_GCS_BUCKET>   # the notebook store bucket
NOTEBOOK_KERNEL_API_URL=<direct run.app URL>     # kernel→API base, Cloudflare-bypassing
REDIS_URL=<secrets.REDIS_URL>                    # durable session registry (multi-instance)
# optional: KERNEL_NAMESPACE, KERNEL_POOL_DEPLOYMENT, KERNEL_ACQUIRE_TIMEOUT_MS,
#           KERNEL_TOKEN_TTL_SECONDS, NOTEBOOK_KERNEL_SECRET (else SESSION_SECRET)
```

Without `KERNEL_PROVIDER`/endpoint the provider auto-detects: a configured GKE
cluster wins, else a static `KERNEL_GATEWAY_URL` (local dev), else notebook
execution reports `503 kernel provider not configured` instead of failing hard.

## Teardown

```bash
kubectl delete namespace mako-notebooks
gcloud container clusters delete mako-notebooks --region europe-west1
gcloud storage rm --recursive gs://<project>-notebook-artifacts
```
