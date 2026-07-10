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
| GCS bucket | `<project>-notebook-artifacts` | notebook outputs + kernel snapshots |
| IAM bindings | node SA | pull images + read/write the bucket |
| k8s namespace | `mako-notebooks` | quota + limits + warm pool + egress policy |

## Prerequisites

- `gcloud` authenticated with project-admin rights on the target project
- `docker`, `kubectl`, and `envsubst` (from `gettext`) on your PATH
- The existing `mako-vpc` / `mako-subnet` network (same one Cloud Run egresses through)

## Run order

```bash
cd deploy/notebook-kernels

# 1. Provision cloud resources (cluster, pool, bucket, registry, IAM).
PROJECT_ID=revops-462013 REGION=europe-west1 ./provision.sh

# 2. Point kubectl at the new cluster.
gcloud container clusters get-credentials mako-notebooks --region europe-west1

# 3. Build + push the kernel image and apply manifests.
PROJECT_ID=revops-462013 REGION=europe-west1 ./build-and-deploy.sh
```

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
| `IMAGE_NAME` | `notebook-kernel` | build-and-deploy |
| `IMAGE_TAG` | current git short SHA | build-and-deploy |

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

## How the control plane uses this (next step, in-repo)

The `KernelProvider` GKE implementation (`api/src/services/kernel-provider/`,
not yet written) claims an idle pod from the `kernel-pool` Deployment via the
k8s API, mints a kernel token, and drives execution over the gateway. Warm-pool
`replicas` trade always-on cost for sub-5s starts; the autoscaler grows the
`kernels` pool to fit demand.

## Teardown

```bash
kubectl delete namespace mako-notebooks
gcloud container clusters delete mako-notebooks --region europe-west1
gcloud storage rm --recursive gs://<project>-notebook-artifacts
```
