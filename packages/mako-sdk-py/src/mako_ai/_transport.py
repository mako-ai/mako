"""HTTP transport for the Mako SDK.

Kept deliberately tiny and dependency-free (stdlib ``urllib``) so the SDK adds
no HTTP dependency to a notebook kernel image. The :class:`Transport` protocol is
the seam the tests inject a fake through — nothing else in the SDK touches the
network directly.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from typing import BinaryIO, Dict, Optional


class Response:
    """A minimal HTTP response usable for both JSON and streamed-bytes bodies.

    ``raw()`` returns a file-like object so an Arrow IPC stream can be handed
    straight to ``pyarrow.ipc.open_stream`` without buffering the whole result.
    """

    def __init__(self, status: int, headers: Dict[str, str], fp: BinaryIO):
        self.status = status
        self.headers = headers
        self._fp = fp

    def raw(self) -> BinaryIO:
        return self._fp

    def read(self) -> bytes:
        return self._fp.read()

    def json(self) -> object:
        return json.loads(self.read().decode("utf-8"))


class Transport:
    """Structural protocol: anything with this ``request`` shape works."""

    def request(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes] = None,
    ) -> Response:  # pragma: no cover - interface definition
        raise NotImplementedError


class UrllibTransport(Transport):
    def __init__(self, timeout: float):
        self._timeout = timeout

    def request(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes] = None,
    ) -> Response:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=self._timeout)
            return Response(
                status=getattr(resp, "status", resp.getcode()),
                headers={k: v for k, v in resp.headers.items()},
                fp=resp,
            )
        except urllib.error.HTTPError as exc:
            # HTTPError is itself a file-like object exposing the error body,
            # so error envelopes (JSON) are still readable via .json()/.read().
            body_bytes = exc.read()
            return Response(
                status=exc.code,
                headers={k: v for k, v in (exc.headers or {}).items()},
                fp=io.BytesIO(body_bytes),
            )
