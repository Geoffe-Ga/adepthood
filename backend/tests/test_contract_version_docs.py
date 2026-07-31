"""Drift guard between the Creek Vault contract version in code and in the docs.

``CONTRACT_VERSION`` in ``domain.creek_vault`` is the single source of truth for
the version adepthood advertises at handshake.  The MCP contract document and
the ADR that pins the HTTP application boundary both restate that version in a
bolded bullet; without a guard those restatements rot silently.  These meta-tests
read the two markdown files and assert the restated versions still equal the
constant, that the version is strict semver (no draft suffix), and that the
contract doc keeps a live pointer to the ADR.
"""

from __future__ import annotations

import re
from pathlib import Path

from domain.creek_vault import CONTRACT_VERSION

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DOC = _REPO_ROOT / "docs" / "adr" / "0004-creek-vault-http-application-boundary.md"
_CONTRACT_DOC = _REPO_ROOT / "docs" / "creek-vault-mcp-contract.md"

_STRICT_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
_CONTRACT_VERSION_LABEL = re.compile(
    r"^- \*\*Contract version:\*\* (\d+\.\d+\.\d+)",
    re.MULTILINE,
)
_PINNED_VERSION_LABEL = re.compile(
    r"^- \*\*Pinned contract version:\*\* (\d+\.\d+\.\d+)",
    re.MULTILINE,
)

_ADR_POINTER = "adr/0004-creek-vault-http-application-boundary.md"
_RETIRED_DRAFT_VERSION = "0.1.0-draft"
_EXPECTED_LABEL_MATCHES = 1


def test_contract_version_is_strict_semver() -> None:
    """The advertised contract version carries no pre-release suffix."""
    assert _STRICT_SEMVER.match(CONTRACT_VERSION), (
        f"CONTRACT_VERSION must be strict MAJOR.MINOR.PATCH semver, got {CONTRACT_VERSION!r}."
    )


def test_boundary_adr_exists() -> None:
    """The ADR pinning the Creek Vault HTTP application boundary is present."""
    assert _ADR_DOC.is_file(), f"Missing boundary ADR at {_ADR_DOC}."


def test_contract_doc_version_matches_constant() -> None:
    """The contract doc's version bullet restates CONTRACT_VERSION exactly."""
    matches = _CONTRACT_VERSION_LABEL.findall(_CONTRACT_DOC.read_text())
    assert len(matches) == _EXPECTED_LABEL_MATCHES, (
        f"Expected exactly one '- **Contract version:** <semver>' line in {_CONTRACT_DOC}, "
        f"found {len(matches)}: {matches}."
    )
    assert matches[0] == CONTRACT_VERSION, (
        f"Contract doc advertises {matches[0]!r} but CONTRACT_VERSION is {CONTRACT_VERSION!r}."
    )


def test_adr_pinned_version_matches_constant() -> None:
    """ADR 0004's pinned-version bullet restates CONTRACT_VERSION exactly."""
    matches = _PINNED_VERSION_LABEL.findall(_ADR_DOC.read_text())
    assert len(matches) == _EXPECTED_LABEL_MATCHES, (
        f"Expected exactly one '- **Pinned contract version:** <semver>' line in {_ADR_DOC}, "
        f"found {len(matches)}: {matches}."
    )
    assert matches[0] == CONTRACT_VERSION, (
        f"ADR pins {matches[0]!r} but CONTRACT_VERSION is {CONTRACT_VERSION!r}."
    )


def test_contract_doc_points_at_adr_and_drops_draft_version() -> None:
    """The contract doc links the boundary ADR and no longer names the draft version."""
    text = _CONTRACT_DOC.read_text()
    assert _ADR_POINTER in text, (
        f"Contract doc must link the boundary ADR ({_ADR_POINTER}) so the pointer cannot rot."
    )
    assert _RETIRED_DRAFT_VERSION not in text, (
        f"Contract doc still mentions the retired {_RETIRED_DRAFT_VERSION!r} version."
    )
