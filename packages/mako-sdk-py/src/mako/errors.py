"""Exception hierarchy for the Mako SDK.

All SDK-raised errors derive from :class:`MakoError` so callers can catch the
whole family with a single ``except mako.MakoError``.
"""

from __future__ import annotations

from typing import Optional


class MakoError(Exception):
    """Base class for every error raised by the Mako SDK."""


class MakoConfigError(MakoError):
    """Raised when required configuration (API URL, workspace, token) is missing."""


class MakoAuthError(MakoError):
    """Raised when the server rejects the credential (HTTP 401/403).

    A kernel token is short-lived and read-only; a 401 usually means it expired
    and the session needs a fresh one.
    """


class MakoNotReadOnlyError(MakoError):
    """Raised before a request when a query is not a read-only SELECT/WITH.

    This is a fast, client-side convenience check. The Mako API is the
    authoritative enforcement point and applies the same rule server-side.
    """


class MakoQueryError(MakoError):
    """Raised when the server reports the query failed or was rejected.

    ``code`` mirrors the machine-readable error code from the API envelope when
    one is present (e.g. ``"PREVIEW_BLOCKED"``, ``"BUDGET_EXCEEDED"``).
    """

    def __init__(self, message: str, *, code: Optional[str] = None, status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status


class MakoSourceNotFoundError(MakoError):
    """Raised when a source name/id cannot be resolved in the workspace."""
