# mako (Python SDK)

Read Mako-managed data sources from a notebook as DataFrames. Reads are
**read-only** and **proxy through the Mako API** — the kernel never opens a
database connection and never holds credentials.

```python
import mako

# In a Mako notebook, config is injected via env (MAKO_API_URL,
# MAKO_WORKSPACE_ID, MAKO_KERNEL_TOKEN). Elsewhere, configure explicitly:
mako.configure(
    api_url="https://app.mako.ai",
    workspace_id="ws_123",
    token="revops_…",          # or a short-lived kernel token
)

mako.sources.list()                        # -> [Source(name="warehouse", ...), ...]
df = mako.sources.sql.read("warehouse", "select date, mrr from metrics.mrr")
tbl = mako.sources.sql.read_arrow("warehouse", "select 1 as n")   # pyarrow.Table, no copy
```

## How it works

- `sources.sql.read(source, query)` resolves the source name → connection id,
  POSTs to the workspace-scoped notebook read endpoint, and streams **Arrow IPC**
  back — loaded zero-copy into pandas (`.read_arrow` returns the `pyarrow.Table`).
- The query must be read-only (`SELECT`/`WITH`); the SDK fast-fails writes and the
  **Mako API is the authoritative enforcement point** (it also applies row/byte/
  time budgets).
- Pass `params=` for server-side parameter binding (safer than f-strings, and the
  right default for agent-written code); `limit=` to cap rows server-side.

## Config

Environment (first non-empty wins per group): `MAKO_API_URL` | `MAKO_API_BASE_URL`;
`MAKO_WORKSPACE_ID`; `MAKO_KERNEL_TOKEN` | `MAKO_TOKEN` | `MAKO_API_KEY`.
Override any field via `mako.configure(...)`.

> The dedicated read endpoint is `…/notebook/read`. To run against an instance
> before it ships, point at the existing Arrow export route:
> `mako.configure(read_path="/api/workspaces/{workspace_id}/execute/export")`.

## Develop / test

```bash
cd packages/mako-sdk-py
PYTHONPATH=src python -m unittest discover -s tests -v
```
