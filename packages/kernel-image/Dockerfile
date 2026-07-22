# Mako notebook kernel image.
#
# A CPU-only Python kernel served over the Jupyter Kernel Gateway. The control
# plane (Cloud Run) drives it via HTTP; the browser never connects directly.
# Analytics libraries + the `mako` SDK are baked in and pre-imported on boot so
# a claimed warm pod is ready immediately.
#
# BUILD CONTEXT = repo root (so the mako SDK can be copied in):
#   docker build -f packages/kernel-image/Dockerfile -t <tag> .
FROM python:3.11-slim AS base

# System libs some analytics wheels dlopen at runtime (matplotlib fonts, etc.).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libgomp1 curl tini \
  && rm -rf /var/lib/apt/lists/*

# Non-root kernel user. UID matches the pod securityContext (runAsUser: 1000).
RUN useradd --create-home --uid 1000 mako
ENV HOME=/home/mako \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg

# --- Python deps ------------------------------------------------------------
# Gateway + kernel first (rarely changes → cached), then the analytics stack.
RUN pip install \
      "jupyter_kernel_gateway>=2.5" \
      "ipykernel>=6.29"
COPY packages/kernel-image/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# --- mako SDK ---------------------------------------------------------------
# Copied from the monorepo and installed from source (not yet on PyPI).
COPY packages/mako-sdk-py /opt/mako-sdk-py
RUN pip install /opt/mako-sdk-py

# Warm the import cache so the first cell doesn't pay import cost. Failure here
# must not break the build (a missing optional import shouldn't block boot).
RUN python -c "import pandas, polars, pyarrow, numpy, matplotlib, plotly, duckdb, mako; print('kernel libs ok')" || true

USER mako
WORKDIR /home/mako
RUN mkdir -p /home/mako/scratch

EXPOSE 8888

# tini reaps zombie kernel subprocesses (PID 1 responsibilities).
ENTRYPOINT ["tini", "--"]
CMD ["jupyter", "kernelgateway", \
     "--KernelGatewayApp.ip=0.0.0.0", \
     "--KernelGatewayApp.port=8888", \
     "--KernelGatewayApp.allow_origin=*", \
     "--JupyterWebsocketPersonality.list_kernels=true"]
