"""Resident dbt engine.

A long-lived Python process that keeps parsed dbt manifests in memory so the
hot interactive loop (parse -> compile -> show) skips the expensive re-parse
on every call. This is the dbt Cloud "develop" model: parse once, then reuse
the in-memory Manifest via dbt-core's programmatic `dbtRunner(manifest=...)`.

Protocol (newline-delimited JSON):
  - Requests arrive on STDIN, one JSON object per line: {"id", "op", ...}.
  - Responses are written to FILE DESCRIPTOR 3, one JSON object per line:
    {"id", "ok", ...}. We do NOT use stdout because dbt-core writes its own
    logs there; stdout/stderr are left for the supervisor to capture as logs.

Sessions are keyed by an opaque string (the supervisor uses project+env). The
supervisor owns the on-disk working directory; this process only reads it.

All assumptions here were verified against dbt-core 1.9.10 + dbt-duckdb 1.9.4
(see api/src/dbt/engine/__tests__ contract test).
"""

import json
import os
import sys
import time
import traceback

import dbt.version
from dbt.cli.main import dbtRunner

# Dedicated protocol channel. dbt logs to stdout/stderr, so responses must not
# share fd 1. Line-buffered so the supervisor sees each response promptly.
_PROTOCOL = os.fdopen(3, "w", buffering=1)


def _send(obj):
    _PROTOCOL.write(json.dumps(obj, default=str) + "\n")
    _PROTOCOL.flush()


# session key -> {"manifest": Manifest, "project_dir": str}
_SESSIONS = {}


def _base(project_dir):
    return [
        "--project-dir",
        project_dir,
        "--profiles-dir",
        project_dir,
        "--no-use-colors",
    ]


def _session(req):
    key = req["session"]
    state = _SESSIONS.get(key)
    if state is None:
        raise RuntimeError(f"no warm session for {key!r}; call prepare first")
    return state


def op_ping(_req):
    return {"dbt_version": dbt.version.get_installed_version().to_version_string()}


def op_prepare(req):
    """Parse the project on disk and cache the manifest under `session`.

    Idempotent: re-parsing picks up file changes the supervisor has written
    (dbt's own checksum-based partial parse keeps this cheap via target/).
    """
    key = req["session"]
    project_dir = req["project_dir"]
    started = time.time()
    result = dbtRunner().invoke(["parse", *_base(project_dir)])
    if not result.success:
        raise RuntimeError(_first_error(result) or "parse failed")
    manifest = result.result
    _SESSIONS[key] = {"manifest": manifest, "project_dir": project_dir}
    return {
        "parse_ms": int((time.time() - started) * 1000),
        "nodes": len(getattr(manifest, "nodes", {}) or {}),
    }


def op_compile(req):
    state = _session(req)
    started = time.time()
    result = dbtRunner(manifest=state["manifest"]).invoke(
        ["compile", *_base(state["project_dir"]), "--select", req["select"]]
    )
    compiled_sql = None
    results = getattr(result.result, "results", None) if result.result else None
    if results:
        node = getattr(results[0], "node", None)
        compiled_sql = getattr(node, "compiled_code", None)
    return {
        "ok": bool(result.success),
        "compiled_sql": compiled_sql,
        "elapsed_ms": int((time.time() - started) * 1000),
        "error": None if result.success else _first_error(result),
    }


def op_show(req):
    state = _session(req)
    args = ["show", *_base(state["project_dir"]), "--limit", str(req.get("limit", 50))]
    if req.get("inline"):
        args += ["--inline", req["inline"]]
    else:
        args += ["--select", req["select"]]
    started = time.time()
    result = dbtRunner(manifest=state["manifest"]).invoke(args)
    columns, rows = [], []
    results = getattr(result.result, "results", None) if result.result else None
    if results:
        table = getattr(results[0], "agate_table", None)
        if table is not None:
            columns = list(table.column_names)
            rows = [list(row) for row in table.rows]
    return {
        "ok": bool(result.success),
        "columns": columns,
        "rows": rows,
        "elapsed_ms": int((time.time() - started) * 1000),
        "error": None if result.success else _first_error(result),
    }


def op_invalidate(req):
    _SESSIONS.pop(req["session"], None)
    return {}


def _first_error(result):
    """Best-effort human-readable failure message from a dbtRunnerResult."""
    if getattr(result, "exception", None):
        return str(result.exception)
    results = getattr(result.result, "results", None) if result.result else None
    if results:
        for node_result in results:
            message = getattr(node_result, "message", None)
            if message:
                return str(message)
    return None


_OPS = {
    "ping": op_ping,
    "prepare": op_prepare,
    "compile": op_compile,
    "show": op_show,
    "invalidate": op_invalidate,
    "evict": op_invalidate,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as error:  # noqa: BLE001 - report and continue
            _send({"id": None, "ok": False, "error": f"bad json: {error}"})
            continue

        rid = req.get("id")
        handler = _OPS.get(req.get("op"))
        if handler is None:
            _send({"id": rid, "ok": False, "error": f"unknown op {req.get('op')!r}"})
            continue

        try:
            payload = handler(req)
            response = {"id": rid, "ok": True}
            response.update(payload)
            _send(response)
        except Exception as error:  # noqa: BLE001 - never let one request kill the loop
            _send(
                {
                    "id": rid,
                    "ok": False,
                    "error": str(error),
                    "trace": traceback.format_exc()[-1500:],
                }
            )


if __name__ == "__main__":
    main()
