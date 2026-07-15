"""``mako.sources`` — list workspace data sources and read them as DataFrames.

Reads proxy through the Mako API: the SDK never opens a database connection and
never sees credentials. The API resolves the connection, enforces read-only +
budgets, and streams Arrow back.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ._client import Client
from .errors import MakoNotReadOnlyError, MakoSourceNotFoundError

# A query is read-only if, after stripping leading comments/whitespace, it starts
# with SELECT or WITH and none of the block-listed write keywords lead it. This
# mirrors the server's checkPreviewQuerySafety; the server remains authoritative.
_LEADING_COMMENT = re.compile(r"^\s*(--[^\n]*\n|/\*.*?\*/|\s)+", re.DOTALL)
_READ_ONLY_START = re.compile(r"^\s*(SELECT|WITH)\b", re.IGNORECASE)
_WRITE_START = re.compile(
    r"^\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE|MERGE|CALL)\b",
    re.IGNORECASE,
)


def _strip_leading_comments(sql: str) -> str:
    prev = None
    out = sql
    while out != prev:
        prev = out
        out = _LEADING_COMMENT.sub("", out, count=1)
    return out


def assert_read_only(query: str) -> None:
    stripped = _strip_leading_comments(query)
    if _WRITE_START.match(stripped) or not _READ_ONLY_START.match(stripped):
        raise MakoNotReadOnlyError(
            "mako.sources.sql.read only accepts read-only queries "
            "(must start with SELECT or WITH). Data sources are read-only from notebooks."
        )


@dataclass
class Source:
    id: str
    name: str
    type: str
    database: Optional[str] = None

    @classmethod
    def from_api(cls, raw: Dict[str, Any]) -> "Source":
        return cls(
            id=str(raw.get("connectionId") or raw.get("id") or raw.get("_id") or ""),
            name=str(raw.get("name") or raw.get("displayName") or ""),
            type=str(raw.get("type") or ""),
            database=raw.get("database"),
        )


class Sql:
    def __init__(self, sources: "Sources"):
        self._sources = sources

    def read(
        self,
        source: str,
        query: str,
        params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
    ):
        """Run a read-only SQL query against ``source`` and return a DataFrame.

        ``source`` is a source name (as shown in Mako) or a connection id.
        Results stream back as Arrow and load zero-copy into pandas. Pass
        ``limit`` to cap rows server-side; ``params`` for server-side parameter
        binding (safer than string-formatting, especially in agent-written code).
        """
        assert_read_only(query)
        client = self._sources._client()
        connection_id = self._sources.resolve(source)
        body: Dict[str, Any] = {"connectionId": connection_id, "query": query, "format": "arrow"}
        if limit is not None:
            body["limit"] = int(limit)
        if params is not None:
            body["params"] = params
        table = client.post_arrow(client.config.read_path, body)
        return table.to_pandas()

    def read_arrow(
        self,
        source: str,
        query: str,
        params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
    ):
        """Like :meth:`read` but returns a ``pyarrow.Table`` (no pandas copy)."""
        assert_read_only(query)
        client = self._sources._client()
        connection_id = self._sources.resolve(source)
        body: Dict[str, Any] = {"connectionId": connection_id, "query": query, "format": "arrow"}
        if limit is not None:
            body["limit"] = int(limit)
        if params is not None:
            body["params"] = params
        return client.post_arrow(client.config.read_path, body)

    def tables(self, source: str) -> List[Dict[str, Any]]:
        """Best-effort: list the top-level catalog nodes for a source.

        Returns the raw tree nodes from the Mako databases tree endpoint; the
        richer typed catalog lands with the notebook data API.
        """
        client = self._sources._client()
        connection_id = self._sources.resolve(source)
        path = client.config.databases_path + "/" + connection_id + "/tree"
        data = client.get_json(path)
        return data if isinstance(data, list) else []


class Sources:
    def __init__(self, get_client: Callable[[], Client]):
        self._get_client = get_client
        self._cache: Optional[List[Source]] = None
        self.sql = Sql(self)

    def _client(self) -> Client:
        return self._get_client()

    def list(self, refresh: bool = False) -> List[Source]:
        """List the workspace's data sources (name, id, type)."""
        if self._cache is None or refresh:
            data = self._client().get_json(self._client().config.databases_path)
            rows = data if isinstance(data, list) else []
            self._cache = [Source.from_api(r) for r in rows]
        return list(self._cache)

    def resolve(self, source: str) -> str:
        """Resolve a source name (case-insensitive) or id to a connection id."""
        matched = self._match(self.list(), source)
        if matched is not None:
            return matched
        # Source may have been created after the cache warmed — refresh once.
        matched = self._match(self.list(refresh=True), source)
        if matched is not None:
            return matched
        return self._not_found(source)

    def _match(self, sources: List[Source], source: str) -> Optional[str]:
        for s in sources:
            if s.id == source:
                return s.id
        lowered = source.lower()
        matches = [s for s in sources if s.name.lower() == lowered]
        if len(matches) == 1:
            return matches[0].id
        if len(matches) > 1:
            raise MakoSourceNotFoundError(
                "Source name %r is ambiguous (%d matches); use the connection id."
                % (source, len(matches))
            )
        return None

    def _not_found(self, source: str) -> str:
        available = ", ".join(s.name for s in (self._cache or [])) or "<none>"
        raise MakoSourceNotFoundError(
            "No data source named or id %r in this workspace. Available: %s"
            % (source, available)
        )
