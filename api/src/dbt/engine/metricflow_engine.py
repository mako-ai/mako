"""MetricFlow compile engine.

A one-shot Python process that turns a stored `semantic_manifest.json` (what
`dbt parse` writes next to manifest.json) into answers about a project's
metrics, with NO dbt project on disk and NO warehouse connection:

  - describe: what the given metrics can be grouped by (dimensions and
    entities, through joins) — the part of the semantic layer that needs
    MetricFlow's join resolution rather than a plain read of the JSON.
  - compile:  the SQL for a metric query in a given dialect. Nothing runs:
    the SQL client handed to MetricFlow only names the dialect and refuses
    every query. Mako executes the SQL through its own drivers.

Protocol: one JSON request on STDIN, one JSON response on STDOUT:
  {"ok": true, ...} or {"ok": false, "error": "<message>"}.
MetricFlow and its dependencies log and print freely, so everything they
write to stdout is redirected to stderr; only the final response line goes
to the real stdout.

It imports `metricflow` only (the same venv as dbt in production, see the
Dockerfile). Verified against metricflow 0.213.0 (see
api/src/dbt/metricflow-engine.contract.test.ts).
"""

import datetime
import json
import os
import re
import sys
import textwrap

# Keep the real stdout for the response; everything else goes to stderr.
_RESPONSE = os.fdopen(os.dup(sys.stdout.fileno()), "w")
sys.stdout = sys.stderr

MAX_ERROR_CHARS = 4000


def _respond(obj):
    _RESPONSE.write(json.dumps(obj, default=str))
    _RESPONSE.write("\n")
    _RESPONSE.flush()


class _CompileOnlySqlClient:
    """Names a dialect and renders plans; never talks to a warehouse."""

    def __init__(self, engine_type, renderer):
        self._engine_type = engine_type
        self._renderer = renderer

    @property
    def sql_engine_type(self):
        return self._engine_type

    @property
    def sql_plan_renderer(self):
        return self._renderer

    def query(self, *args, **kwargs):
        raise RuntimeError("compile-only client: queries are not run here")

    def execute(self, *args, **kwargs):
        raise RuntimeError("compile-only client: statements are not run here")

    def dry_run(self, *args, **kwargs):
        raise RuntimeError("compile-only client: dry runs are not run here")

    def close(self):
        pass

    def render_bind_parameter_key(self, bind_parameter_key):
        return f":{bind_parameter_key}"


def _sql_client(dialect):
    from metricflow.protocols.sql_client import SqlEngine

    if dialect == "postgres":
        from metricflow.sql.render.postgres import PostgresSQLSqlPlanRenderer

        return _CompileOnlySqlClient(SqlEngine.POSTGRES, PostgresSQLSqlPlanRenderer())
    if dialect == "redshift":
        from metricflow.sql.render.redshift import RedshiftSqlPlanRenderer

        return _CompileOnlySqlClient(SqlEngine.REDSHIFT, RedshiftSqlPlanRenderer())
    if dialect == "bigquery":
        from metricflow.sql.render.big_query import BigQuerySqlPlanRenderer

        return _CompileOnlySqlClient(SqlEngine.BIGQUERY, BigQuerySqlPlanRenderer())
    if dialect == "duckdb":
        from metricflow.sql.render.duckdb_renderer import DuckDbSqlPlanRenderer

        return _CompileOnlySqlClient(SqlEngine.DUCKDB, DuckDbSqlPlanRenderer())
    raise ValueError(f"Unsupported dialect: {dialect!r}")


def _engine(manifest_path, dialect):
    from metricflow.engine.metricflow_engine import MetricFlowEngine
    from metricflow_semantics.model.dbt_manifest_parser import (
        parse_manifest_from_dbt_generated_manifest,
    )
    from metricflow_semantics.model.semantic_manifest_lookup import (
        SemanticManifestLookup,
    )

    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = parse_manifest_from_dbt_generated_manifest(
            manifest_json_string=handle.read()
        )
    return MetricFlowEngine(
        semantic_manifest_lookup=SemanticManifestLookup(manifest),
        sql_client=_sql_client(dialect),
    )


def _enum_value(value):
    return getattr(value, "value", value)


def op_describe(req):
    """What the metrics can be grouped by: common to all of them."""
    from metricflow.engine.models import Dimension

    # The dialect does not change which group-bys exist.
    engine = _engine(req["manifest_path"], req.get("dialect") or "postgres")
    metrics = list(req["metrics"])
    dimensions = []
    entities = []
    for item in engine.list_group_bys(metric_names=metrics):
        if isinstance(item, Dimension):
            kind = _enum_value(item.type)
            entry = {
                "name": item.dunder_name,
                "type": kind,
            }
            if kind == "time":
                # `metric_time__day` → ask for a coarser grain by replacing
                # the suffix: `metric_time__month`.
                entry["base"] = item.granularity_free_dunder_name
                if item.type_params is not None:
                    entry["grain"] = _enum_value(item.type_params.time_granularity)
            if item.label:
                entry["label"] = item.label
            if item.description:
                entry["description"] = item.description
            dimensions.append(entry)
        else:
            entry = {"name": item.name, "type": _enum_value(item.type)}
            if item.description:
                entry["description"] = item.description
            entities.append(entry)
    return {"ok": True, "dimensions": dimensions, "entities": entities}


def _parse_time(value, name):
    if value is None:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(str(value).strip())
    except ValueError:
        raise ValueError(
            f'{name} "{value}" is not a date ("2026-01-01") or a datetime '
            'without a timezone ("2026-01-01T00:00:00").'
        ) from None
    # MetricFlow compares the bounds with naive datetimes, and an aware one
    # fails with "can't compare offset-naive and offset-aware datetimes".
    # The offset is dropped and the wall-clock time kept.
    return parsed.replace(tzinfo=None)


def op_compile(req):
    from metricflow.engine.metricflow_engine import MetricFlowQueryRequest

    start = _parse_time(req.get("start_time"), "startTime")
    end = _parse_time(req.get("end_time"), "endTime")
    if start is not None and end is not None and start > end:
        raise ValueError(
            f"startTime ({start.isoformat()}) is after endTime ({end.isoformat()}): "
            "the range holds no rows. Swap them."
        )
    engine = _engine(req["manifest_path"], req["dialect"])
    request = MetricFlowQueryRequest.create(
        metric_names=list(req["metrics"]),
        group_by_names=list(req.get("group_by") or []) or None,
        where_constraints=list(req.get("where") or []) or None,
        order_by_names=list(req.get("order_by") or []) or None,
        limit=req.get("limit"),
        time_constraint_start=start,
        time_constraint_end=end,
    )
    statement = engine.explain(request).sql_statement
    if statement.bind_parameter_set.param_items:
        # Mako runs the SQL as text; a statement that needs bound values
        # cannot be handed over faithfully.
        raise ValueError("The compiled SQL needs bind parameters, which is not supported.")
    return {"ok": True, "sql": statement.sql}


OPS = {"describe": op_describe, "compile": op_compile}

_TRACEBACK = "Traceback (most recent call last):"
_EXCEPTION_LINE = re.compile(r"^\s*(?:[\w.]+\.)?(\w+(?:Error|Exception)): (.+)$", re.M)


def _clean_error(message):
    """The first message block of a MetricFlow error, as a caller can act on it.

    MetricFlow's query-resolution errors number each problem and append the
    resolver's own call path; a bad Jinja filter embeds three chained Python
    tracebacks. Kept: the first problem's message and the input it is about.
    Dropped: the tracebacks (the root cause's last line stays) and the path.
    """
    text = message
    first = re.search(
        r"Error #1:\n\s*Message:\n(.*?)(?=\n\s*Error #2:|\Z)", text, re.S
    )
    more = len(re.findall(r"^\s*Error #\d+:", text, re.M)) - 1
    if first:
        text = re.split(r"\n\s*Issue Location:", first.group(1))[0]
    if _TRACEBACK in text:
        head, tail = text.split(_TRACEBACK, 1)
        head = re.sub(r"\s*Got exception:\s*$", "", head)
        cause = _EXCEPTION_LINE.search(tail)
        text = head
        if cause:
            text += f"\n\n{cause.group(1)}: {cause.group(2).strip()}"
    text = textwrap.dedent(text.strip("\n")).strip()
    if more > 0:
        text += f"\n\n(+{more} more error{'s' if more > 1 else ''})"
    return text or message


def main():
    try:
        req = json.loads(sys.stdin.read())
        handler = OPS.get(req.get("op"))
        if handler is None:
            _respond({"ok": False, "error": f"unknown op: {req.get('op')!r}"})
            return
        _respond(handler(req))
    except Exception as error:  # noqa: BLE001 - every failure is a response
        message = _clean_error(str(error).strip()) or type(error).__name__
        _respond({"ok": False, "error": message[:MAX_ERROR_CHARS]})


if __name__ == "__main__":
    main()
