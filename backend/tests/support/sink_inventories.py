"""Read every inventory the sink registry is held complete against (#3158).

:func:`privacy.sinks.registry_gaps` is pure; this module supplies its input from
the code and documents that own each inventory, so the registry is checked
against them rather than against a copy:

* the recipient register's ids (:data:`privacy.recipients.RECIPIENTS`);
* the store inventory's keys (``domain.retention_stores.STORES``);
* every ``EncryptedString`` column the ORM declares
  (``services.encryption_inventory.encrypted_columns``);
* every transport row of ``docs/qa/telemetry-egress-inventory.md``, by its bold
  name;
* the detached egress entry points of the barrier-totality gate.

Each reader takes its source as an argument with the shipped one as default,
so a meta-test can plant a row in a copy and watch the registry fail.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Final

from sqlalchemy import MetaData

from domain.retention_stores import STORES, Store
from privacy.recipients import RECIPIENTS
from privacy.sinks import Inventory
from services.encryption_inventory import encrypted_columns
from tests.security.test_egress_barrier_totality import DETACHED_ENTRY_POINTS
from tests.support.pytest_node_ids import REPO_ROOT

TELEMETRY_INVENTORY: Final = REPO_ROOT / "docs" / "qa" / "telemetry-egress-inventory.md"

#: A transport row: ``| 7a | **`slowapi`** (...) | ...``. The name is the bold run.
_TRANSPORT_ROW: Final = re.compile(r"^\| *\d+[a-z]? *\| *\*\*(.+?)\*\*", re.MULTILINE)


def recipient_keys(register: Iterable[str] = RECIPIENTS) -> frozenset[str]:
    """Every recipient register id."""
    return frozenset(str(rid) for rid in register)


def store_keys(stores: Iterable[Store] = STORES) -> frozenset[str]:
    """Every non-database store the retention inventory lists."""
    return frozenset(store.key for store in stores)


def encrypted_column_keys(metadata: MetaData | None = None) -> frozenset[str]:
    """Every ``table.column`` typed ``EncryptedString``."""
    return frozenset(column.qualified for column in encrypted_columns(metadata))


def telemetry_transport_keys(text: str | None = None) -> frozenset[str]:
    """Every transport in the telemetry inventory table, by bold name with backticks dropped."""
    source = TELEMETRY_INVENTORY.read_text(encoding="utf-8") if text is None else text
    return frozenset(name.replace("`", "").strip() for name in _TRANSPORT_ROW.findall(source))


def detached_egress_keys(entry_points: Iterable[str] = DETACHED_ENTRY_POINTS) -> frozenset[str]:
    """Every egress entry point that belongs to no route."""
    return frozenset(entry_points)


def shipped_inventories() -> Mapping[Inventory, frozenset[str]]:
    """All five inventories as the tree has them now."""
    return {
        Inventory.RECIPIENT_REGISTER: recipient_keys(),
        Inventory.RETENTION_STORES: store_keys(),
        Inventory.ENCRYPTED_COLUMNS: encrypted_column_keys(),
        Inventory.TELEMETRY_TRANSPORTS: telemetry_transport_keys(),
        Inventory.DETACHED_EGRESS: detached_egress_keys(),
    }
