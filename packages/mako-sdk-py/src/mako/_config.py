"""Configuration resolution for the Mako SDK.

Config comes from the environment by default (that is how the kernel runner
injects it into a notebook process), with optional per-field overrides passed to
:func:`mako.configure`.

Environment variables (first non-empty wins within each group):

- API base URL:   ``MAKO_API_URL`` | ``MAKO_API_BASE_URL``
- Workspace id:   ``MAKO_WORKSPACE_ID``
- Bearer token:   ``MAKO_KERNEL_TOKEN`` | ``MAKO_TOKEN`` | ``MAKO_API_KEY``
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, Optional

from .errors import MakoConfigError

# The dedicated, budgeted, read-only notebook read endpoint (delivered by the
# companion backend slice). Point at ``/api/workspaces/{workspace_id}/execute/export``
# via ``configure(read_path=...)`` to run against an instance before it ships.
DEFAULT_READ_PATH = "/api/workspaces/{workspace_id}/notebook/read"
# Source resolution goes through the kernel-token-authed notebook route (id /
# name / type only). The generic ``/databases`` route rejects kernel tokens and
# echoes credentialed connection docs, so it must not be reachable from a kernel.
DEFAULT_DATABASES_PATH = "/api/workspaces/{workspace_id}/notebook/sources"
DEFAULT_TIMEOUT_SECONDS = 300.0


def _first_env(*names: str) -> Optional[str]:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


@dataclass
class Config:
    """Resolved SDK configuration."""

    api_url: str
    workspace_id: str
    token: str
    read_path: str = DEFAULT_READ_PATH
    databases_path: str = DEFAULT_DATABASES_PATH
    timeout: float = DEFAULT_TIMEOUT_SECONDS

    def base_url(self) -> str:
        # Normalize so joining with a leading-slash path never doubles slashes.
        return self.api_url.rstrip("/")


def resolve_config(overrides: Optional[Dict[str, object]] = None) -> Config:
    """Build a :class:`Config` from the environment plus explicit overrides.

    Raises :class:`MakoConfigError` listing every missing required field so a
    notebook author sees all gaps at once instead of one at a time.
    """
    overrides = dict(overrides or {})

    api_url = overrides.pop("api_url", None) or _first_env("MAKO_API_URL", "MAKO_API_BASE_URL")
    workspace_id = overrides.pop("workspace_id", None) or _first_env("MAKO_WORKSPACE_ID")
    token = overrides.pop("token", None) or _first_env(
        "MAKO_KERNEL_TOKEN", "MAKO_TOKEN", "MAKO_API_KEY"
    )

    missing = []
    if not api_url:
        missing.append("api_url (MAKO_API_URL)")
    if not workspace_id:
        missing.append("workspace_id (MAKO_WORKSPACE_ID)")
    if not token:
        missing.append("token (MAKO_KERNEL_TOKEN)")
    if missing:
        raise MakoConfigError(
            "Mako SDK is not configured. Missing: "
            + ", ".join(missing)
            + ". Set the environment variables or call mako.configure(...)."
        )

    return Config(
        api_url=str(api_url),
        workspace_id=str(workspace_id),
        token=str(token),
        read_path=str(overrides.pop("read_path", DEFAULT_READ_PATH)),
        databases_path=str(overrides.pop("databases_path", DEFAULT_DATABASES_PATH)),
        timeout=float(overrides.pop("timeout", DEFAULT_TIMEOUT_SECONDS)),
    )
