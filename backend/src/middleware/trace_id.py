"""Trace-ID middleware re-export.

The actual implementation lives in :mod:`observability` next to the
contextvar and log filter that depend on it; the middleware ships from
this module so :mod:`main` can compose middleware classes from a single
``middleware`` package without conflating them with the trace-id
mechanics that other modules (workers, log handlers) also import.

BUG-APP-007: :mod:`main` calls :func:`observability.install_trace_id_logging`
at import time, not inside the lifespan startup hook, so log records
emitted while the routers are being mounted carry a ``trace_id`` field
(``"-"`` outside a request, the request UUID inside one).
"""

from __future__ import annotations

from observability import CorrelationIdMiddleware

__all__ = ["CorrelationIdMiddleware"]
