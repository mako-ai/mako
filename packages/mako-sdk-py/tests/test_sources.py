import io
import json
import unittest

import pyarrow as pa

from mako._client import Client
from mako._config import Config
from mako._sources import Sources, assert_read_only
from mako._transport import Response
from mako.errors import (
    MakoAuthError,
    MakoNotReadOnlyError,
    MakoQueryError,
    MakoSourceNotFoundError,
)


def _json_response(status, payload):
    return Response(status, {}, io.BytesIO(json.dumps(payload).encode("utf-8")))


def _arrow_response(table):
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return Response(200, {}, io.BytesIO(sink.getvalue().to_pybytes()))


class FakeTransport:
    """Routes requests to a handler and records calls for assertions."""

    def __init__(self, handler):
        self._handler = handler
        self.calls = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url, headers, body))
        return self._handler(method, url, body)


def _make_sources(handler):
    cfg = Config(api_url="https://x", workspace_id="ws1", token="revops_test")
    client = Client(cfg, transport=FakeTransport(handler))
    return Sources(lambda: client), client


DATABASES = {
    "success": True,
    "data": [
        {"connectionId": "conn_wh", "name": "warehouse", "type": "bigquery"},
        {"connectionId": "conn_pg", "name": "app_db", "type": "postgresql"},
    ],
}


class ReadOnlyGuardTest(unittest.TestCase):
    def test_allows_select_and_with(self):
        assert_read_only("select 1")
        assert_read_only("  -- comment\n WITH t AS (select 1) select * from t")

    def test_blocks_writes(self):
        for q in ["delete from t", "DROP TABLE t", "update t set x=1", "insert into t values (1)"]:
            with self.assertRaises(MakoNotReadOnlyError):
                assert_read_only(q)


class SourcesTest(unittest.TestCase):
    def test_list_parses_sources(self):
        sources, _ = _make_sources(lambda m, u, b: _json_response(200, DATABASES))
        result = sources.list()
        self.assertEqual([s.name for s in result], ["warehouse", "app_db"])
        self.assertEqual(result[0].id, "conn_wh")
        self.assertEqual(result[0].type, "bigquery")

    def test_resolve_by_name_and_id(self):
        sources, _ = _make_sources(lambda m, u, b: _json_response(200, DATABASES))
        self.assertEqual(sources.resolve("warehouse"), "conn_wh")
        self.assertEqual(sources.resolve("WAREHOUSE"), "conn_wh")  # case-insensitive
        self.assertEqual(sources.resolve("conn_pg"), "conn_pg")  # by id

    def test_resolve_unknown_raises(self):
        sources, _ = _make_sources(lambda m, u, b: _json_response(200, DATABASES))
        with self.assertRaises(MakoSourceNotFoundError):
            sources.resolve("nope")


class ReadTest(unittest.TestCase):
    def _handler_factory(self, read_response):
        def handler(method, url, body):
            if url.endswith("/databases"):
                return _json_response(200, DATABASES)
            if url.endswith("/notebook/read"):
                self.last_read_body = json.loads(body.decode("utf-8"))
                return read_response
            raise AssertionError("unexpected URL " + url)

        return handler

    def test_read_returns_dataframe(self):
        table = pa.table({"n": [1, 2, 3], "label": ["a", "b", "c"]})
        sources, client = _make_sources(self._handler_factory(_arrow_response(table)))
        df = sources.sql.read("warehouse", "select n, label from t", limit=100)
        self.assertEqual(list(df.columns), ["n", "label"])
        self.assertEqual(df["n"].tolist(), [1, 2, 3])
        # Body carried the resolved connection id + arrow format + limit.
        self.assertEqual(self.last_read_body["connectionId"], "conn_wh")
        self.assertEqual(self.last_read_body["format"], "arrow")
        self.assertEqual(self.last_read_body["limit"], 100)

    def test_read_arrow_returns_table(self):
        table = pa.table({"n": [10]})
        sources, _ = _make_sources(self._handler_factory(_arrow_response(table)))
        result = sources.sql.read_arrow("conn_wh", "select n from t")
        self.assertIsInstance(result, pa.Table)
        self.assertEqual(result.column("n").to_pylist(), [10])

    def test_read_rejects_writes_before_network(self):
        called = {"n": 0}

        def handler(method, url, body):
            called["n"] += 1
            return _json_response(200, DATABASES)

        sources, _ = _make_sources(handler)
        with self.assertRaises(MakoNotReadOnlyError):
            sources.sql.read("warehouse", "delete from t")
        self.assertEqual(called["n"], 0)  # no request was made

    def test_auth_error_maps(self):
        resp = _json_response(401, {"success": False, "error": "token expired"})
        sources, _ = _make_sources(self._handler_factory(resp))
        with self.assertRaises(MakoAuthError):
            sources.sql.read("warehouse", "select 1")

    def test_query_error_carries_code(self):
        resp = _json_response(400, {"error": "over budget", "code": "BUDGET_EXCEEDED"})
        sources, _ = _make_sources(self._handler_factory(resp))
        with self.assertRaises(MakoQueryError) as ctx:
            sources.sql.read("warehouse", "select 1")
        self.assertEqual(ctx.exception.code, "BUDGET_EXCEEDED")
        self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
