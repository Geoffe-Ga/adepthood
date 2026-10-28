"""Run the synthetic corpus through the real resonance pipeline and score it.

:func:`run_corpus` drives the production ``generate_marginalia`` and
``generate_essay`` with any number of model configurations, scores each result
with :func:`~tests.reflection_eval.rubric.score_reflection`, and returns a
:class:`ScoresReport`. The report holds the reflection text in memory, because
the blinded review packet needs it; the only serialisation of the report
itself, :func:`to_content_free_json`, writes ids, rule ids and counts and
nothing else (the B10 telemetry invariant).

:func:`blind_packet` is the separate, local-only artefact for human reviewers:
model labels become opaque ids derived from a seed, items are ordered by a
seeded hash so models interleave, and the label key is returned apart and must
be written to a different directory (:func:`write_review_files`). Ordering uses
sha256 rather than :mod:`random` -- reproducible from the seed alone, and not a
pseudo-random generator for a linter to question.

Nothing here touches the network. The doubles are scripted;
:class:`ObservedStubLLM` reaches the in-process stub provider and must only be
used with ``BOTMASON_PROVIDER=stub`` and no key in the environment.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from domain.resonance import (
    ESSAY_TASK_INSTRUCTION,
    MarginaliaAnchored,
    MarginaliaDraft,
    generate_essay,
    generate_marginalia,
)
from models.marginalia import MarginaliaSource
from services.marginalia import BotmasonResonanceLLM, receipt_for
from tests.reflection_eval.corpus import CASES, CORPUS_DIGEST, CORPUS_ID, CORPUS_VERSION, EvalCase
from tests.reflection_eval.rubric import (
    Excluded,
    ExclusionReason,
    ReflectionSample,
    ReflectionScore,
    RuleId,
    score_reflection,
)

#: Hex characters of the seeded hash kept in an opaque reviewer-facing model id.
OPAQUE_ID_HEX = 10

#: The tail of the well-behaved double's letter: second person, no self-reference.
_GROUNDED_LETTER_TAIL = "You set that down and kept going. It is yours to come back to, or not."
_GROUNDED_NOTE = "You set this down plainly; it may carry more than it says."


class ObservedLLM(Protocol):
    """A ``ResonanceLLM`` that also reports which sources actually answered it."""

    async def complete(self, prompt: str) -> str:
        """Return the completion for ``prompt``."""

    @property
    def sources(self) -> frozenset[MarginaliaSource | None]:
        """The sources observed answering so far (read after the run)."""


LLMFactory = Callable[[EvalCase], ObservedLLM]


@dataclass
class ScriptedResonanceLLM:
    """A double that answers notes prompts with ``drafts`` and essay prompts with ``letter``."""

    drafts: tuple[MarginaliaDraft, ...]
    letter: str
    prompts: list[str] = field(default_factory=list)

    async def complete(self, prompt: str) -> str:
        """Return the scripted letter for an essay prompt, else the scripted notes JSON."""
        self.prompts.append(prompt)
        if ESSAY_TASK_INSTRUCTION in prompt:
            return self.letter
        notes = [{"kind": d.kind, "quote": d.quote, "note": d.note} for d in self.drafts]
        return json.dumps({"notes": notes})

    @property
    def sources(self) -> frozenset[MarginaliaSource | None]:
        """A scripted double stands in for a real app provider."""
        return frozenset({MarginaliaSource.APP_PROVIDER})


def grounded_llm(case: EvalCase) -> ScriptedResonanceLLM:
    """The well-behaved double: anchors the case's quote and quotes it back verbatim."""
    return ScriptedResonanceLLM(
        drafts=(MarginaliaDraft(kind="theme", quote=case.quote, note=_GROUNDED_NOTE),),
        letter=f"You wrote: \u201c{case.quote}\u201d\n\n{_GROUNDED_LETTER_TAIL}",
    )


class ObservedStubLLM:
    """The production adapter, with its sources read from what actually answered.

    Wraps :class:`~services.marginalia.BotmasonResonanceLLM` -- the seam the
    journal router uses -- so demo status comes from the B07 receipt of every
    metered response, not from a label this class declares.
    """

    def __init__(self) -> None:
        """Build the adapter with no BYOK key."""
        self._inner = BotmasonResonanceLLM(None)

    async def complete(self, prompt: str) -> str:
        """Delegate to the production adapter."""
        return await self._inner.complete(prompt)

    @property
    def sources(self) -> frozenset[MarginaliaSource | None]:
        """The receipt source of every response the adapter metered."""
        return frozenset(receipt_for(response).source for response in self._inner.usage)


@dataclass(frozen=True)
class CaseRun:
    """One model's run over one case: pipeline counts, score and (in memory) text."""

    label: str
    case_id: str
    result: Excluded | ReflectionScore
    pipeline: Mapping[str, int | bool]
    letter_refused: bool
    observed_sources: frozenset[MarginaliaSource | None]
    notes: tuple[MarginaliaAnchored, ...]
    letter: str | None


@dataclass(frozen=True)
class ScoresReport:
    """Every run of every model over one corpus version."""

    corpus_id: str
    corpus_version: str
    corpus_digest: str
    runs: tuple[CaseRun, ...]


@dataclass(frozen=True)
class Aggregate:
    """Counts over scored reflections only (a demo cannot be passed in)."""

    scored: int
    failing: int
    rule_counts: Mapping[RuleId, int]


async def _run_case(label: str, case: EvalCase, llm: ObservedLLM) -> CaseRun:
    """Drive the real pipeline for one case and score what reached the writer."""
    outcome = await generate_marginalia(case.entry, llm=llm, prior_drafts=case.prior_drafts)
    notes = tuple(outcome.notes)
    letter = None
    if notes:
        letter = await generate_essay(
            llm=llm, body=case.entry, note=notes[0], prior_drafts=case.prior_drafts
        )
    sources = llm.sources
    sample = ReflectionSample(
        case_id=case.case_id,
        language=case.language,
        entry=case.entry,
        notes=notes,
        letter=letter,
        sources=sources,
    )
    return CaseRun(
        label=label,
        case_id=case.case_id,
        result=score_reflection(sample),
        pipeline=outcome.as_log_extra(),
        letter_refused=bool(notes) and letter is None,
        observed_sources=sources,
        notes=notes,
        letter=letter,
    )


async def run_corpus(
    models: Mapping[str, LLMFactory], cases: Sequence[EvalCase] = CASES
) -> ScoresReport:
    """Run every case through every model configuration, a fresh model per case."""
    runs = [
        await _run_case(label, case, factory(case))
        for label, factory in models.items()
        for case in cases
    ]
    return ScoresReport(
        corpus_id=CORPUS_ID,
        corpus_version=CORPUS_VERSION,
        corpus_digest=CORPUS_DIGEST,
        runs=tuple(runs),
    )


def scores_for(report: ScoresReport, label: str) -> list[ReflectionScore]:
    """The scored (non-demo) results of one model."""
    return [
        run.result
        for run in report.runs
        if run.label == label and isinstance(run.result, ReflectionScore)
    ]


def aggregate(scores: Iterable[ReflectionScore]) -> Aggregate:
    """Count scored reflections, failing ones, and how often each rule fired."""
    listed = list(scores)
    counts: Counter[RuleId] = Counter(rule for score in listed for rule in score.rule_ids)
    return Aggregate(
        scored=len(listed),
        failing=sum(not score.passes for score in listed),
        rule_counts=dict(counts),
    )


def _excluded_count(runs: Iterable[CaseRun], reason: ExclusionReason) -> int:
    """How many of ``runs`` were excluded for ``reason``."""
    return sum(isinstance(run.result, Excluded) and run.result.reason is reason for run in runs)


def _model_summary(report: ScoresReport, label: str) -> dict[str, object]:
    """One model's content-free block of the scores file."""
    runs = [run for run in report.runs if run.label == label]
    totals = aggregate(scores_for(report, label))
    return {
        "scored": totals.scored,
        "failing": totals.failing,
        "excluded_demo": _excluded_count(runs, ExclusionReason.DEMO),
        "excluded_unobserved": _excluded_count(runs, ExclusionReason.UNOBSERVED),
        "rule_counts": {rule.value: n for rule, n in sorted(totals.rule_counts.items())},
        "cases": [
            {
                "case_id": run.case_id,
                "excluded": (run.result.reason.value if isinstance(run.result, Excluded) else None),
                "rules": (
                    sorted(v.rule.value for v in run.result.violations)
                    if isinstance(run.result, ReflectionScore)
                    else []
                ),
                "letter_refused": run.letter_refused,
                "pipeline": dict(run.pipeline),
            }
            for run in runs
        ],
    }


def to_content_free_json(report: ScoresReport) -> str:
    """Serialise ``report`` as ids, rule ids and counts -- never any text."""
    labels = list(dict.fromkeys(run.label for run in report.runs))
    payload = {
        "corpus": {
            "id": report.corpus_id,
            "version": report.corpus_version,
            "digest": report.corpus_digest,
        },
        "models": {label: _model_summary(report, label) for label in labels},
    }
    return json.dumps(payload, sort_keys=True)


def _seeded_hex(seed: str, *parts: str) -> str:
    """A sha256 hex digest of ``seed`` and ``parts``, for ids and ordering."""
    return hashlib.sha256(":".join((seed, *parts)).encode("utf-8")).hexdigest()


def blind_packet(report: ScoresReport, seed: str) -> tuple[list[dict[str, object]], dict[str, str]]:
    """Return a blinded review packet and, separately, its opaque-id -> label key.

    Demo-excluded runs are left out: there is nothing in them to review.
    """
    scored = [run for run in report.runs if isinstance(run.result, ReflectionScore)]
    opaque = {
        run.label: "R-" + _seeded_hex(seed, "model", run.label)[:OPAQUE_ID_HEX] for run in scored
    }
    ordered = sorted(scored, key=lambda run: _seeded_hex(seed, "item", run.label, run.case_id))
    packet: list[dict[str, object]] = [
        {
            "model": opaque[run.label],
            "case_id": run.case_id,
            "margin_notes": [{"passage": n.anchor_text, "text": n.note} for n in run.notes],
            "letter_text": run.letter,
        }
        for run in ordered
    ]
    key = {opaque_id: label for label, opaque_id in opaque.items()}
    return packet, key


def write_review_files(
    packet: list[dict[str, object]],
    key: Mapping[str, str],
    *,
    packet_path: Path,
    key_path: Path,
) -> None:
    """Write the packet and its key to separate, unnested directories, local only.

    Refusing a shared or nested directory is the point: a reviewer handed the
    packet's folder -- with everything beneath it -- must not be handed the key
    with it, and vice versa. Paths are resolved first, so ``..`` cannot hide a
    shared folder. Nothing is written when the check fails.
    """
    packet_dir, key_dir = packet_path.resolve().parent, key_path.resolve().parent
    if packet_dir.is_relative_to(key_dir) or key_dir.is_relative_to(packet_dir):
        msg = "The review packet and its key must be written to separate directories."
        raise ValueError(msg)
    for path, data in ((packet_path, packet), (key_path, dict(key))):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
