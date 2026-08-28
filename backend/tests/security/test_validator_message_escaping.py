r"""A validator message must never interpolate client text bare.

``repr()`` of an unpaired surrogate is pure ASCII -- ``repr("a\udbdbb")`` is the
ten characters ``'a\udbdbb'`` -- so a message built with ``!r`` survives being
rendered into a 422 body.  Bare interpolation does not, and it does not fail
where anyone would look for it:

    raise ValueError(f"rejected {value!r}")   ->  422, msg="Value error, rejected 'a\udbdbb'"
    raise ValueError(f"rejected {value}")     ->  UnicodeEncodeError, unhandled, 500

pydantic-core builds the error message eagerly, inside ``validate_python``, and
encodes it as UTF-8 while doing so.  A surrogate in that message therefore
raises *out of validation itself* -- before any response renderer is reached, so
none of the response-side reasoning applies -- and an unhandled exception is a
500.  The caller who typed an odd character is told the server broke.

Every message in this application that quotes client text already uses ``!r``.
That is the whole of what keeps the hazard unreachable on those paths, and it
is a convention, held in no linter and stated in no docstring until now.  This
module is what makes it enforced rather than observed.

Two layers, because they fail differently:

* **The named sites**, driven individually.  These are the validators that
  receive client text today; each would fail here if its ``!r`` were dropped.
* **The sweep**, which walks the live route table and probes every field of
  every request-body model reachable from it.  This is what catches a *new*
  validator written next year by someone who never read this file.  It is
  deliberately mechanical: it discovers its own inputs, so it does not go stale
  as models are added.

The sweep asserts against its own vacuity three ways: a floor on how many models
it discovered, a check that every probe shape provoked a rejection somewhere, and
a direct assertion that the probe still holds a code point UTF-8 refuses to
encode.  The third is the one that matters.  Both of the others count
rejections, and an ordinary string is rejected exactly as readily as a
surrogate-bearing one -- so somebody normalising the probe, to quiet an editor
or survive a copy-paste, would leave every count healthy and every test in this
module passing over a value no validator has any trouble with.
"""

from __future__ import annotations

import typing
from collections.abc import Callable, Iterator

import pytest
from pydantic import BaseModel, ValidationError

from domain.reflection_hierarchy import ReflectionLevel, scope_weeks
from domain.timezone import check_timezone_resolves
from schemas.goal import GoalUpdate
from schemas.practice_mode_config import TalliedGroundingConfig
from services.creek_vault_payload import _is_storable_ref
from tests.helpers.openapi_errors import route_index

# An unpaired high surrogate, as a code point so this file stays plain ASCII.
_LONE_SURROGATE = chr(0xDBDB)
_PROBE = "a" + _LONE_SURROGATE + "b"

# The surrogate block, for the probe-integrity check below.
_SURROGATE_FIRST = 0xD800
_SURROGATE_LAST = 0xDFFF

# Shapes a field might accept: a bare string, a list member, a mapping key, a
# mapping value, and a nested list inside a mapping.  Between them these reach
# every annotation in this application that can hold a string at all.
_PROBE_SHAPES: tuple[object, ...] = (
    _PROBE,
    [_PROBE],
    {_PROBE: 1},
    {"k": _PROBE},
    {"k": [_PROBE]},
)

# A floor, not a target.  If model discovery stops matching this application --
# a FastAPI release reshaping the route tree, a router mounted somewhere new --
# this is what turns a vacuous pass into a failure.  It sits comfortably below
# the 52 observed when this was written, so ordinary growth never trips it and
# ordinary shrinkage is not how it gets hit.
_MIN_BODY_MODELS = 40


def _models_in(annotation: object) -> Iterator[type[BaseModel]]:
    """Yield every model class reachable from ``annotation``, unions included."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        yield annotation
    for argument in typing.get_args(annotation):
        yield from _models_in(argument)


def _request_body_models() -> set[type[BaseModel]]:
    """Return every model any route accepts as a body, transitively.

    Read off the resolved dependency tree rather than off imports, so a model
    that stopped being a request body drops out on its own and one that starts
    being one is picked up without this file being edited.

    ``route_index`` is the suite's existing walk over the mounted routes; it
    already knows that an included router appears as a wrapper rather than as
    its endpoints. Reusing it keeps that FastAPI-shaped knowledge in one place,
    so a release that reshapes ``app.routes`` breaks one helper loudly instead
    of leaving a private copy here quietly finding nothing.
    """
    found: set[type[BaseModel]] = set()
    for route in route_index().values():
        pending, seen = [route.dependant], set()
        while pending:
            dependant = pending.pop()
            if id(dependant) in seen:
                continue
            seen.add(id(dependant))
            pending.extend(dependant.dependencies)
            for param in getattr(dependant, "body_params", []):
                found.update(_models_in(param.field_info.annotation))
    frontier = list(found)
    while frontier:
        for field in frontier.pop().model_fields.values():
            for nested in _models_in(field.annotation):
                if nested not in found:
                    found.add(nested)
                    frontier.append(nested)
    return found


def _assert_message_renderable(exc: BaseException, label: str) -> None:
    """Assert ``exc`` is an ordinary rejection whose text can be rendered.

    ``UnicodeEncodeError`` is itself a ``ValueError``, so catching ``ValueError``
    would swallow exactly the failure under test; the type is checked
    explicitly.  The message is then encoded, because a rejection nobody can
    serialise is a 500 by another name.
    """
    assert not isinstance(exc, UnicodeError), (
        f"{label}: validation raised {type(exc).__name__} instead of rejecting the value -- "
        "a message interpolated client text without !r"
    )
    try:
        str(exc).encode("utf-8")
    except UnicodeEncodeError as encode_error:  # pragma: no cover - the defect itself
        pytest.fail(f"{label}: rejection message cannot be rendered ({encode_error})")


def _reject_timezone() -> None:
    """Feed the probe to the timezone boundary shared by signup and profile update."""
    check_timezone_resolves(_PROBE)


def _reject_weekday() -> None:
    """Feed the probe to the weekday allowlist on the goal update body."""
    GoalUpdate.model_validate({"days_of_week": [_PROBE]})


def _reject_reflection_key() -> None:
    """Feed the probe to the reflection-scope key parser."""
    scope_weeks(ReflectionLevel.WEEK, _PROBE)


def _reject_duplicate_category() -> None:
    """Feed the probe to the tallied-grounding duplicate-key check.

    Two categories sharing the probe as their key, so the duplicate branch --
    the one that quotes the key back -- is the branch that fires.
    """
    TalliedGroundingConfig.model_validate(
        {
            "mode": "tallied_grounding",
            "rounds": 1,
            "categories": [
                {"key": _PROBE, "label": "a"},
                {"key": _PROBE, "label": "b"},
            ],
        }
    )


_NAMED_SITES: tuple[tuple[str, Callable[[], None]], ...] = (
    ("domain.timezone", _reject_timezone),
    ("schemas.goal days_of_week", _reject_weekday),
    ("domain.reflection_hierarchy key parser", _reject_reflection_key),
    ("schemas.practice_mode_config category key", _reject_duplicate_category),
)


@pytest.mark.parametrize(("label", "provoke"), _NAMED_SITES, ids=[s[0] for s in _NAMED_SITES])
def test_named_validator_quotes_client_text_safely(label: str, provoke: Callable[[], None]) -> None:
    """Each validator that quotes client text rejects a surrogate instead of dying."""
    with pytest.raises(ValueError) as caught:  # noqa: PT011 - the type is asserted below
        provoke()
    _assert_message_renderable(caught.value, label)


def test_the_probe_is_actually_hazardous() -> None:
    """The probe must really hold an unpaired surrogate, or the module tests nothing.

    The loudest way this file could rot is not a broken walker or a drifting
    shape list -- it is somebody normalising ``_PROBE`` into an ordinary string,
    perhaps to silence an editor or a copy-paste. Every assertion here would go
    on passing, over a value no validator has any trouble with. Neither the
    model floor nor the per-shape check would notice, because both count
    rejections and an ordinary string is rejected just as readily.

    So the hazard is asserted directly: the probe holds a code point in the
    surrogate block, and UTF-8 refuses to encode it.
    """
    assert any(_SURROGATE_FIRST <= ord(ch) <= _SURROGATE_LAST for ch in _PROBE), (
        f"the probe {_PROBE!r} holds no surrogate; every test in this module is vacuous"
    )
    with pytest.raises(UnicodeEncodeError):
        _PROBE.encode("utf-8")


def test_no_request_body_model_dies_on_a_surrogate() -> None:
    """No body model may raise anything but a rejection when handed a surrogate.

    The forward-looking half.  Every field of every request-body model is fed
    each probe shape; anything that is not a ``ValidationError`` is a validator
    that tried to build a message it could not encode.

    Field validators all run even when other fields are missing -- pydantic
    collects the whole error set before deciding -- so a partial payload still
    exercises them.  Model-level ``mode="after"`` validators do not run behind
    a field error, and are covered instead by the route-level module beside
    this one, which drives them through real requests.
    """
    models = _request_body_models()
    assert len(models) >= _MIN_BODY_MODELS, (
        f"only {len(models)} request-body models found; model discovery has stopped "
        "matching this application and is checking almost nothing"
    )
    reached = dict.fromkeys(range(len(_PROBE_SHAPES)), 0)
    for model in models:
        for name in model.model_fields:
            for index, shape in enumerate(_PROBE_SHAPES):
                try:
                    model.model_validate({name: shape})
                except ValidationError as rejection:
                    reached[index] += 1
                    _assert_message_renderable(rejection, f"{model.__name__}.{name}")
                except Exception as exc:  # noqa: BLE001 - the point is the type
                    _assert_message_renderable(exc, f"{model.__name__}.{name}")
                    pytest.fail(f"{model.__name__}.{name}: unexpected {type(exc).__name__}: {exc}")
    unused = [_PROBE_SHAPES[index] for index, hits in reached.items() if hits == 0]
    assert not unused, (
        f"probe shapes {unused!r} provoked no rejection anywhere; they no longer reach "
        "this application's fields, so that much of the sweep is passing vacuously"
    )


def test_storable_ref_bound_excludes_lone_surrogates() -> None:
    """The vault fragment-id bound refuses a surrogate, via ``str.isprintable``.

    ``vault_ref`` is the one upstream-supplied string that reaches a response
    body with no database row in between, so no flush-time guard stands behind
    it.  ``str.isprintable`` is what closes it -- an unpaired surrogate is
    Unicode category ``Cs`` and therefore not printable -- which is a property
    of that bound, not its purpose.  Pinned because a change narrowing the
    bound to the code points its docstring actually names would reopen the path
    while looking like a clarification.
    """
    assert _is_storable_ref("fragment-1") is True
    assert _is_storable_ref(_PROBE) is False
