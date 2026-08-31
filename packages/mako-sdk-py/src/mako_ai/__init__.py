"""Mako SDK — read Mako-managed data sources from notebooks as DataFrames.

Typical use inside a Mako notebook (config is injected via env by the kernel
runner, so no setup is needed)::

    import mako

    sources = mako.sources.list()
    df = mako.sources.sql.read("warehouse", "select date, mrr from metrics.mrr")

Reads are read-only and proxy through the Mako API — the kernel never holds
database credentials.
"""

from __future__ import annotations

from ._client import configure, get_default_client, reset_default_client
from ._sources import Source, Sources
from .errors import (
    MakoAuthError,
    MakoConfigError,
    MakoError,
    MakoNotReadOnlyError,
    MakoQueryError,
    MakoSourceNotFoundError,
)

__version__ = "0.1.0"

# The module-level entry point. Bound to the process-wide default client, which
# is lazily built from env/`configure(...)` the first time it is used.
sources = Sources(get_default_client)


def saved_query(name: str):  # noqa: ARG001 - placeholder signature is intentional
    """Run a saved Mako console/query by name and return a DataFrame.

    Delivered with the notebook data API (see backend slice); raises until then
    so callers get a clear message instead of a silent no-op.
    """
    raise NotImplementedError(
        "mako.saved_query is delivered with the notebook data API; "
        "use mako.sources.sql.read(...) in the meantime."
    )


__all__ = [
    "__version__",
    "configure",
    "reset_default_client",
    "sources",
    "saved_query",
    "Source",
    "Sources",
    "MakoError",
    "MakoConfigError",
    "MakoAuthError",
    "MakoNotReadOnlyError",
    "MakoQueryError",
    "MakoSourceNotFoundError",
]
