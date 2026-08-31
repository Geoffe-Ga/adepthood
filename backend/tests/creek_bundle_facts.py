"""The pinned facts about the vendored Creek ``/v1`` contract bundle, stated once.

Two suites assert against the bundle under ``tests/fixtures/creek_v1/`` --
``test_creek_contract_conformance.py`` reads wire shapes out of it, and
``tests/scripts/test_creek_contract_drift.py`` pins the checker that guards it --
and both need the same handful of numbers and strings: which commit the copy was
cut from, which versions it carries, and how many files and example cells it
holds. They used to restate all of them, so a re-vendor that updated one module
left the other asserting a bundle that no longer existed, and the second failure
only surfaced after the first was fixed.

Every value here is *measured from the bundle and then written down*, which is
what makes it an assertion rather than a tautology: nothing in this module is
derived at import time from the files it describes, so an emptied or truncated
bundle fails the suites instead of quietly redefining what "correct" means.

This module has no ``test_`` prefix, so pytest never collects it as a test file.
"""

from __future__ import annotations

#: Creek's own name for the bundle, carried in both manifests.
BUNDLE_NAME = "adepthood-v1"

#: The upstream repository the bundle is vendored from.
PINNED_REPO = "Geoffe-Ga/creek-vault"

#: The directory inside that repository the bundle is copied from.
PINNED_PATH = "docs/contracts/adepthood-v1"

#: The upstream commit the vendored copy was fetched at. A sha rather than a
#: branch: a branch name would let the "pinned" copy move underneath the digests
#: that are the only thing making it a pin.
PINNED_COMMIT = "f9354bc289995c87578b944b63883794035011f7"  # pragma: allowlist secret

#: The contract version the vendored bundle publishes. Restated rather than read
#: from ``domain.creek_vault``, so the suites compare two independent claims
#: instead of agreeing with whatever the pin happens to say.
PINNED_CONTRACT_VERSION = "0.10.0"

#: The ontology the wire vocabulary is drawn from. Unchanged across 0.8 to 0.10.
ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"

#: Files listed inside Creek's own ``manifest.json``. It covers neither itself
#: nor the hand-written ``README.md``, which is why this is two short of the
#: vendored total.
CREEK_MANIFEST_ENTRIES = 77

#: Files our ``vendor.json`` sidecar records. The sidecar excludes only itself:
#: it is the record, not the record's subject.
VENDORED_FILES = 79

#: JSON Schemas the bundle publishes -- one per entry in Creek's own
#: ``CONTRACT_MODELS``. It grew with the capability axis: 0.7 published 16.
SCHEMA_FILES = 27

#: Capabilities on the example matrix's first axis, at contract 0.10.0:
#: ``capabilities``, ``journal-upsert``, ``reflections``, ``wheel``, ``upload``,
#: ``drive-connector`` and ``pipeline``.
CAPABILITY_COUNT = 7

#: States on the matrix's second axis. Unchanged since the matrix was published.
STATE_COUNT = 7

#: Cells in the published example matrix -- one per (capability, state) pair.
#: Written out rather than multiplied, so a suite can still assert that the two
#: axes and the cell count are three agreeing observations of one grid.
EXAMPLE_CELLS = 49

#: Cells holding Creek's "this branch does not exist" sentinel. The care guard
#: runs in ``reflections`` alone, so every other capability's ``care-escalation``
#: cell is a ``NotApplicableExample`` rather than a document a client can be
#: driven with.
UNREACHABLE_CELLS = 6

#: Cells a client can actually be driven with.
REACHABLE_CELLS = EXAMPLE_CELLS - UNREACHABLE_CELLS
