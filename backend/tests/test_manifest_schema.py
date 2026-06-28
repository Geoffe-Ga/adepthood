"""Contract tests for the content manifest schema (issue #389).

The manifest is the frozen interface between the ``aptitude-course``
content repo and this app: the content repo's frontmatter generates it,
the sync script vendors it, and the backend reader consumes it.  These
tests pin the contract — the example document must validate, and the
schema must actually reject malformed manifests (a vacuously-permissive
schema would "pass" everything and protect nothing).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

_CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"
_SCHEMA_PATH = _CONTENT_DIR / "manifest.schema.json"
_EXAMPLE_PATH = _CONTENT_DIR / "manifest.example.json"


def _load(path: Path) -> dict[str, Any]:
    with path.open() as f:
        return cast("dict[str, Any]", json.load(f))


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    """The manifest JSON Schema, checked for self-validity once."""
    document = _load(_SCHEMA_PATH)
    Draft202012Validator.check_schema(document)
    return document


@pytest.fixture(scope="module")
def example() -> dict[str, Any]:
    return _load(_EXAMPLE_PATH)


def test_example_manifest_validates(schema: dict[str, Any], example: dict[str, Any]) -> None:
    """The shipped example is a conforming manifest — downstream tests build on it."""
    Draft202012Validator(schema).validate(example)


def test_example_covers_the_contract_surface(example: dict[str, Any]) -> None:
    """Per the issue: one stage, two chapters, one site resource, one intro."""
    assert len(example["chapters"]) == 2
    assert len({c["stage"] for c in example["chapters"]}) == 1
    assert len(example["site_resources"]) == 1
    # schema_version 1.1.0 ships the additive stage_intros[] tier.
    assert example["schema_version"] == "1.1.0"
    assert len(example["stage_intros"]) == 1
    major, minor, patch = example["schema_version"].split(".")
    assert all(part.isdigit() for part in (major, minor, patch))


def test_stage_intros_are_optional_for_backwards_compatibility(
    schema: dict[str, Any],
    example: dict[str, Any],
) -> None:
    """A 1.0.0-shaped manifest with no stage_intros must still validate."""
    legacy = json.loads(json.dumps(example))
    legacy.pop("stage_intros")
    legacy["schema_version"] = "1.0.0"
    Draft202012Validator(schema).validate(legacy)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda m: m.pop("schema_version"), id="missing schema_version"),
        pytest.param(lambda m: m.pop("chapters"), id="missing chapters"),
        pytest.param(lambda m: m["chapters"][0].pop("id"), id="chapter missing id"),
        pytest.param(lambda m: m["chapters"][0].pop("path"), id="chapter missing path"),
        pytest.param(
            lambda m: m["chapters"][0].update(content_type="podcast"),
            id="content_type outside the enum",
        ),
        pytest.param(lambda m: m["chapters"][0].update(stage=0), id="stage below 1"),
        pytest.param(
            lambda m: m["chapters"][0].update(stage=11),
            id="stage above the 10-stage curriculum",
        ),
        pytest.param(lambda m: m["chapters"][0].update(release_day=-1), id="negative release_day"),
        pytest.param(lambda m: m.update(surprise_field=True), id="unknown top-level field"),
        pytest.param(lambda m: m["site_resources"][0].pop("slug"), id="site resource missing slug"),
        pytest.param(
            lambda m: m["site_resources"][0].update(extra=True),
            id="site resource unknown field",
        ),
        pytest.param(lambda m: m["stage_intros"][0].pop("path"), id="stage_intro missing path"),
        pytest.param(lambda m: m["stage_intros"][0].pop("stage"), id="stage_intro missing stage"),
        pytest.param(
            lambda m: m["stage_intros"][0].update(stage=0),
            id="stage_intro stage below 1",
        ),
        pytest.param(
            lambda m: m["stage_intros"][0].update(stage=11),
            id="stage_intro stage above the 10-stage curriculum",
        ),
        pytest.param(
            lambda m: m["stage_intros"][0].update(extra=True),
            id="stage_intro unknown field",
        ),
    ],
)
def test_schema_rejects_malformed_manifests(
    schema: dict[str, Any],
    example: dict[str, Any],
    mutate: Callable[[dict[str, Any]], object],
) -> None:
    """The schema must have teeth — each mutation must fail validation."""
    broken = json.loads(json.dumps(example))
    mutate(broken)
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(broken)
