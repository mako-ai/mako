"""The Mako HTTP client and the process-wide default client.

The client owns auth headers, URL construction, error mapping, and the two
request shapes the SDK needs: JSON (catalog) and Arrow-stream (reads). Everything
user-facing (``mako.sources.*``) is a thin layer over this.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._config import Config, resolve_config
from ._transport import Response, Transport, UrllibTransport
from .errors import MakoAuthError, MakoError, MakoQueryError


class Client:
    def __init__(self, config: Config, transport: Optional[Transport] = None):
        self.config = config
        self._transport = transport or UrllibTransport(timeout=config.timeout)

    # -- URL + headers --------------------------------------------------------

    def _url(self, path_template: str) -> str:
        path = path_template.format(workspace_id=self.config.workspace_id)
        return self.config.base_url() + path

    def _headers(self, accept: str) -> Dict[str, str]:
        return {
            "Authorization": "Bearer " + self.config.token,
            "Accept": accept,
            "Content-Type": "application/json",
        }

    # -- error mapping --------------------------------------------------------

    def _raise_for_status(self, resp: Response) -> None:
        if 200 <= resp.status < 300:
            return
        message = "Mako API request failed (HTTP %d)" % resp.status
        code = None
        try:
            body = resp.json()
            if isinstance(body, dict):
                message = str(body.get("error") or body.get("message") or message)
                raw_code = body.get("code")
                code = str(raw_code) if raw_code is not None else None
        except Exception:
            pass
        if resp.status in (401, 403):
            raise MakoAuthError(message)
        raise MakoQueryError(message, code=code, status=resp.status)

    # -- request shapes -------------------------------------------------------

    def get_json(self, path_template: str) -> Any:
        resp = self._transport.request(
            "GET", self._url(path_template), self._headers("application/json")
        )
        self._raise_for_status(resp)
        return _unwrap_envelope(resp.json())

    def post_json(self, path_template: str, body: Dict[str, Any]) -> Any:
        import json

        resp = self._transport.request(
            "POST",
            self._url(path_template),
            self._headers("application/json"),
            json.dumps(body).encode("utf-8"),
        )
        self._raise_for_status(resp)
        return _unwrap_envelope(resp.json())

    def post_arrow(self, path_template: str, body: Dict[str, Any]):
        """POST a JSON body and read an Arrow IPC stream response into a Table."""
        import json

        import pyarrow as pa  # local import: only reads need pyarrow

        resp = self._transport.request(
            "POST",
            self._url(path_template),
            self._headers("application/vnd.apache.arrow.stream"),
            json.dumps(body).encode("utf-8"),
        )
        self._raise_for_status(resp)
        reader = pa.ipc.open_stream(resp.raw())
        return reader.read_all()


def _unwrap_envelope(body: Any) -> Any:
    """Unwrap Mako's ``{success, data, error}`` envelope.

    Success payloads return ``data``; ``success: false`` raises. Bodies without
    the envelope (already-unwrapped) pass through unchanged.
    """
    if isinstance(body, dict) and "success" in body:
        if body.get("success") is False:
            raise MakoError(str(body.get("error") or "Mako API returned success=false"))
        return body.get("data", body)
    return body


# -- process-wide default client ---------------------------------------------

_overrides: Dict[str, object] = {}
_default_client: Optional[Client] = None


def configure(**kwargs: object) -> None:
    """Set/override SDK configuration for the default client.

    Accepts any :class:`~mako._config.Config` field (``api_url``,
    ``workspace_id``, ``token``, ``read_path``, ``databases_path``, ``timeout``).
    Overrides merge over the environment and take effect on next use.
    """
    global _default_client
    _overrides.update(kwargs)
    _default_client = None


def get_default_client() -> Client:
    global _default_client
    if _default_client is None:
        _default_client = Client(resolve_config(_overrides))
    return _default_client


def reset_default_client() -> None:
    """Testing/hygiene helper: drop the cached client and overrides."""
    global _default_client
    _overrides.clear()
    _default_client = None
