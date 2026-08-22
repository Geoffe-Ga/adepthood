"""Drift guards between the Creek Vault contract in code and the docs that pin it.

Four kinds of restatement rot silently without a guard, and all four are
covered here.

*Version restatements.* ``CONTRACT_VERSION`` in ``domain.creek_vault`` is the
single source of truth for the version adepthood advertises at handshake.  The
contract pointer document and the ADR that pins the HTTP application boundary
both restate that version in a bolded bullet.  These meta-tests read the two
markdown files and assert the restated versions still equal the constant, that
the version is strict semver (no draft suffix), and that the contract doc keeps
a live pointer to the ADR.

*Transport restatements.* The seam is HTTP/JSON ``/v1`` and has been since the
cutover; MCP is Creek's adapter for agents and was never meant to carry
application data.  A document that still advertises the old arrangement is not
a stale detail, because the pattern it advertises is the one this repository
ruled out by name -- so the living documents are swept for it.  Ratified
records and the dated files under ``plan/`` are outside that sweep: their
present-tense sentences about the pre-cutover world are evidence, amended by
dated note rather than rewritten.

*Ownership pointers.* The intimate-transit sub-decisions live in the boundary
ADR's Decision 6; the contract doc explicitly disclaims owning them.  A docstring
that cites the contract doc as the source of those decisions therefore points at
a document that denies holding the rule.  The next meta-tests pin that
ownership from both ends: the docs must keep saying where the rule lives, and no
``backend/src`` module docstring may cite the contract doc as a decision's owner
or discuss intimate transit without naming the ADR that owns it.

*Tenancy restatements.* The vault's single-tenant binding is the same shape of
rule one document further on: Decision 7 of the same ADR owns it, the contract
doc disclaims it exactly as it disclaims intimate transit, and the operator meets
it as one environment variable.  That variable is the whole rule as far as a
deployment is concerned, so an ``.env.example`` that does not mention it is a
deployment configured to hand a vault to nobody without saying why -- which makes
documenting it a guard rather than a courtesy.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from pathlib import Path

from domain.creek_vault import CONTRACT_VERSION

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADR_DOC = _REPO_ROOT / "docs" / "adr" / "0004-creek-vault-http-application-boundary.md"
_CONTRACT_DOC = _REPO_ROOT / "docs" / "creek-vault-mcp-contract.md"
_ENV_EXAMPLE = _REPO_ROOT / "backend" / ".env.example"
_BACKEND_SRC = _REPO_ROOT / "backend" / "src"

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

# The repo-relative paths source docstrings cite the two documents by.
_CONTRACT_DOC_PATH = "docs/creek-vault-mcp-contract.md"
_ADR_DOC_PATH = "docs/adr/0004-creek-vault-http-application-boundary.md"

# The sentence the contract doc uses to hand the intimate-transit rule to the
# ADR.  If it is reworded, the docstrings that rely on it need re-reviewing too.
_CONTRACT_DOC_DISCLAIMER = "Decision 6, not in this document"

# The ADR section that owns the rule, and the four sub-decisions it carries.
_INTIMATE_DECISION_HEADING = "## Decision 6"
_INTIMATE_SUB_DECISIONS = (
    "**(a) Transit topology",
    "**(b) Write-vs-read",
    "**(c) Reflection-output provenance",
    "**(d) Custody end-state",
)

# Matches a docstring citing the contract doc as the *owner* of a decision, e.g.
# "``docs/creek-vault-mcp-contract.md`` decisions (a) ...".  Creek's published
# contract owns wire shapes and the ADRs own decisions; this doc owns neither.
# Deliberately narrow, to keep the legitimate citations it still earns (its tier
# mapping and fallback rules) from tripping it; the keyword-pair check below is
# the wording-independent backstop for phrasings this pattern would miss.
_CONTRACT_DOC_AS_DECISION_OWNER = re.compile(
    r"creek-vault-mcp-contract\.md`*(?:'s)?[\s,]*(?:sub-)?decisions?\b",
    re.IGNORECASE,
)

# A module docstring mentioning both of these is discussing the intimate-transit
# rule and must therefore name the ADR that records it.
_INTIMATE_TRANSIT_MARKERS = ("intimate", "transit")

# The sentence the contract doc uses to hand the vault-tenancy rule to the ADR,
# mirroring the intimate-transit disclaimer above and pinned for the same reason:
# a reworded hand-off leaves the docstrings that cite the ADR resting on a
# document that no longer says where the rule lives.
_CONTRACT_DOC_TENANCY_DISCLAIMER = "Decision 7, not in this document"

# The ADR section that owns the single-tenant binding, and its four sub-decisions.
_TENANCY_DECISION_HEADING = "## Decision 7"
_TENANCY_SUB_DECISIONS = (
    "**(a) Identity scope",
    "**(b) Owner binding",
    "**(c) Fail-closed default",
    "**(d) Per-user end-state",
)

# The one environment variable the tenancy rule reaches an operator through.
_VAULT_OWNER_ENV_VAR = "CREEK_VAULT_OWNER_USER_ID"

# The vision document names the seam in one phrase, which is the phrase most
# readers will ever see about it.
_NORTH_STAR = _REPO_ROOT / "NORTH-STAR.md"
_HTTP_SEAM_PHRASE = "Creek Vault HTTP/JSON seam"

# The construction that presents MCP as adepthood's own way of reaching the
# vault.  Deliberately requires whitespace between the two words, so the
# retained filename `creek-vault-mcp-contract.md` -- a path, not a claim about
# a transport -- does not trip it.
_MCP_AS_VAULT_TRANSPORT = re.compile(r"creek[- ]?vault\s+mcp", re.IGNORECASE)

# Documents that describe the system as it is now, and must therefore say
# HTTP.  `plan/` is outside this on purpose: those are dated records of what
# was believed on a day, and correcting them would falsify the log.
_CURRENT_PROSE_TREES = ("docs", "graph")
_CURRENT_PROSE_ROOT_DOCS = ("NORTH-STAR.md", "README.md", "CLAUDE.md", "AGENTS.md")

# Ratified records are amended by dated note, never rewritten, so their
# present-tense sentences about the pre-cutover world are history rather than
# claims -- see the notes appended to each of them.
_HISTORICAL_PROSE = (_REPO_ROOT / "docs" / "adr",)

# A sweep that visited nothing would present as a clean one.
_MINIMUM_PROSE_FILES_SCANNED = 10

# The retitled pointer doc.  Its path still says MCP for link stability into
# the ratified record; its title no longer has to.
_CONTRACT_DOC_TITLE_FORBIDS = "mcp"


def _module_docstrings() -> Iterator[tuple[Path, str]]:
    """Yield every ``backend/src`` module path with its whitespace-normalized docstring.

    Normalizing runs of whitespace to single spaces lets the pointer patterns
    match across the line wrapping the formatter imposes on long docstrings.
    """
    for path in sorted(_BACKEND_SRC.rglob("*.py")):
        docstring = ast.get_docstring(ast.parse(path.read_text(encoding="utf-8")))
        if docstring:
            yield path, " ".join(docstring.split())


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


def test_contract_doc_disclaims_the_intimate_transit_rule() -> None:
    """The contract doc still hands the intimate-transit rule to the ADR by name."""
    assert _CONTRACT_DOC_DISCLAIMER in _CONTRACT_DOC.read_text(encoding="utf-8"), (
        f"Contract doc must keep saying the intimate-transit rule lives in the ADR "
        f"({_CONTRACT_DOC_DISCLAIMER!r}); source docstrings cite the ADR on that basis."
    )


def test_boundary_adr_owns_the_intimate_transit_sub_decisions() -> None:
    """ADR 0004's Decision 6 still carries all four intimate-transit sub-decisions."""
    text = _ADR_DOC.read_text(encoding="utf-8")
    assert _INTIMATE_DECISION_HEADING in text, (
        f"ADR must keep the {_INTIMATE_DECISION_HEADING!r} heading that docstrings cite."
    )
    missing = [marker for marker in _INTIMATE_SUB_DECISIONS if marker not in text]
    assert not missing, f"ADR Decision 6 is missing sub-decisions: {missing}."


def test_contract_doc_disclaims_the_vault_tenancy_rule() -> None:
    """The contract doc still hands the single-tenant binding to the ADR by name."""
    assert _CONTRACT_DOC_TENANCY_DISCLAIMER in _CONTRACT_DOC.read_text(encoding="utf-8"), (
        f"Contract doc must keep saying the vault-tenancy rule lives in the ADR "
        f"({_CONTRACT_DOC_TENANCY_DISCLAIMER!r}); source docstrings cite the ADR on that basis."
    )


def test_boundary_adr_owns_the_vault_tenancy_sub_decisions() -> None:
    """ADR 0004's Decision 7 still carries all four single-tenant sub-decisions."""
    text = _ADR_DOC.read_text(encoding="utf-8")
    assert _TENANCY_DECISION_HEADING in text, (
        f"ADR must keep the {_TENANCY_DECISION_HEADING!r} heading that docstrings cite."
    )
    missing = [marker for marker in _TENANCY_SUB_DECISIONS if marker not in text]
    assert not missing, f"ADR Decision 7 is missing sub-decisions: {missing}."


def test_env_example_documents_the_vault_owner_variable() -> None:
    """The env template names the variable a vault is bound to one user by.

    Undocumented, the fail-closed default reads as a broken vault: replication
    silently stops for everyone and the only clue is one WARNING an operator has
    no reason to expect.
    """
    assert _VAULT_OWNER_ENV_VAR in _ENV_EXAMPLE.read_text(encoding="utf-8"), (
        f"{_ENV_EXAMPLE} must document {_VAULT_OWNER_ENV_VAR}: without it, a configured "
        f"vault belongs to nobody and nothing in the template says why."
    )


def test_no_backend_source_cites_the_contract_doc_as_a_decision_owner() -> None:
    """No ``backend/src`` docstring attributes a decision to the pointer doc."""
    offenders = [
        str(path.relative_to(_REPO_ROOT))
        for path, docstring in _module_docstrings()
        if _CONTRACT_DOC_AS_DECISION_OWNER.search(docstring)
    ]
    assert not offenders, (
        f"These module docstrings cite {_CONTRACT_DOC_PATH} as a decision's owner, but "
        f"that document disclaims owning decisions -- cite {_ADR_DOC_PATH} instead: "
        f"{offenders}."
    )


def _current_prose_files() -> list[Path]:
    """Every document that describes the seam as it stands today."""
    files = [
        path
        for tree in _CURRENT_PROSE_TREES
        for path in (_REPO_ROOT / tree).rglob("*.md")
        if not any(historical in path.parents for historical in _HISTORICAL_PROSE)
    ]
    files.extend(_REPO_ROOT / name for name in _CURRENT_PROSE_ROOT_DOCS)
    return [path for path in files if path.is_file()]


def test_north_star_names_the_seam_that_ships() -> None:
    """The vision document calls the Creek seam HTTP/JSON, because that is what it is."""
    text = _NORTH_STAR.read_text(encoding="utf-8")
    assert _HTTP_SEAM_PHRASE in text, (
        f"{_NORTH_STAR.name} must name the seam as {_HTTP_SEAM_PHRASE!r}; it is the one "
        f"phrase most readers will ever see about how adepthood reaches the vault."
    )


def test_no_current_document_presents_mcp_as_the_vault_transport() -> None:
    """MCP is Creek's adapter for agents; no live document may sell it as ours.

    Application data transfer over MCP is the pattern this repository ruled out
    by name, so a document advertising it is not a stale detail -- it is an
    invitation to rebuild the thing that was retired.
    """
    offenders: list[str] = []
    scanned = 0
    for path in _current_prose_files():
        scanned += 1
        offenders += [
            f"{path.relative_to(_REPO_ROOT)}: {match.group(0)!r}"
            for match in _MCP_AS_VAULT_TRANSPORT.finditer(path.read_text(encoding="utf-8"))
        ]
    assert not offenders, "\n".join(offenders)
    assert scanned >= _MINIMUM_PROSE_FILES_SCANNED, f"only {scanned} files scanned -- scan broke"


def test_contract_doc_title_does_not_advertise_mcp() -> None:
    """The pointer doc keeps its path for link stability, but not its old title."""
    title = _CONTRACT_DOC.read_text(encoding="utf-8").splitlines()[0]
    assert _CONTRACT_DOC_TITLE_FORBIDS not in title.lower(), (
        f"The contract doc's title still advertises MCP ({title!r}); the path is retained "
        f"for the inbound references the ADR names, which is not a reason to keep the title."
    )


def test_backend_sources_discussing_intimate_transit_cite_the_adr() -> None:
    """Docstrings covering intimate transit name the ADR that records the rule."""
    offenders = [
        str(path.relative_to(_REPO_ROOT))
        for path, docstring in _module_docstrings()
        if all(marker in docstring.lower() for marker in _INTIMATE_TRANSIT_MARKERS)
        and _ADR_DOC_PATH not in docstring
    ]
    assert not offenders, (
        f"These module docstrings discuss intimate transit without citing "
        f"{_ADR_DOC_PATH}, the document that records the rule: {offenders}."
    )
