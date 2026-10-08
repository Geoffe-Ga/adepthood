"""End-to-end tests for the evaluation corpus and harness (#3074 ACs 2, 4, 11-16).

These drive the real ``generate_marginalia`` / ``generate_essay`` pipeline with
scripted doubles (and, for demo exclusion, the in-process stub provider), so
they prove both halves of the division of labour: what the pipeline already
drops, and what it lets through for the rubric to catch.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import replace
from pathlib import Path

import pytest

from domain.resonance import MarginaliaDraft, _quote_span
from models.marginalia import MarginaliaSource
from tests.reflection_eval.corpus import (
    CASES,
    CORPUS_DIGEST,
    CORPUS_VERSION,
    EvalCase,
    corpus_digest,
)
from tests.reflection_eval.harness import (
    CaseRun,
    ObservedStubLLM,
    ScoresReport,
    ScriptedResonanceLLM,
    aggregate,
    blind_packet,
    grounded_llm,
    run_corpus,
    scores_for,
    to_content_free_json,
    write_review_files,
)
from tests.reflection_eval.rubric import ExcludedDemo, ReflectionScore, RuleId, quote_occurrences

#: Window length for the content-free check: long enough that a hit means real
#: text leaked, short enough to catch a truncated excerpt.
_LEAK_WINDOW = 12
_SENTENCE = re.compile(r"[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]")
_REQUIRED_TAGS = frozenset(
    {"plain", "repeated", "multilingual", "nfd", "injection", "medication", "distress"}
    | {"prior_letter"}
)
_REQUIRED_LANGUAGES = frozenset({"en", "es", "de", "ja", "ar"})
_SECOND_PERSON_NOTE = "You came back to this line twice; it seems to matter to you."


def _case(tag: str) -> EvalCase:
    """Return the first corpus case carrying ``tag``."""
    return next(case for case in CASES if tag in case.tags)


def _only_run(report: ScoresReport) -> CaseRun:
    """Return the single run of a one-case, one-model report."""
    (run,) = report.runs
    return run


def _scored(run: CaseRun) -> ReflectionScore:
    """Return the run's score, failing if it was excluded as a demo."""
    assert isinstance(run.result, ReflectionScore), run.result
    return run.result


def _scripted(case: EvalCase, letter: str) -> ScriptedResonanceLLM:
    """A model that anchors the case's quote faithfully and writes ``letter``."""
    return ScriptedResonanceLLM(
        drafts=(MarginaliaDraft(kind="theme", quote=case.quote, note=_SECOND_PERSON_NOTE),),
        letter=letter,
    )


@pytest.fixture
def stub_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the in-process stub as the configured provider, with no key anywhere."""
    monkeypatch.setenv("BOTMASON_PROVIDER", "stub")
    monkeypatch.delenv("LLM_API_KEY", raising=False)


# --- corpus -----------------------------------------------------------------


def test_corpus_digest_changes_with_content() -> None:
    """Editing any case's text changes the digest, so runs stay comparable (AC16)."""
    edited = (replace(CASES[0], entry=CASES[0].entry + " One more line."), *CASES[1:])
    reordered_tags = (replace(CASES[0], tags=frozenset(sorted(CASES[0].tags))), *CASES[1:])
    assert corpus_digest(edited) != corpus_digest(CASES)
    assert corpus_digest(reordered_tags) == corpus_digest(CASES)


def test_corpus_digest_is_pinned() -> None:
    """The committed digest is the corpus's real digest (AC16)."""
    assert corpus_digest(CASES) == CORPUS_DIGEST, (
        f"The synthetic corpus changed. Bump CORPUS_VERSION (now {CORPUS_VERSION!r}) "
        f"and repin CORPUS_DIGEST to {corpus_digest(CASES)!r}."
    )


def test_corpus_covers_required_case_families() -> None:
    """Every case family the issue names is present, under unique ids."""
    tags = frozenset().union(*(case.tags for case in CASES))
    assert tags >= _REQUIRED_TAGS
    assert {case.language for case in CASES} >= _REQUIRED_LANGUAGES
    assert len({case.case_id for case in CASES}) == len(CASES)


# --- pipeline vs rubric -----------------------------------------------------


@pytest.mark.asyncio
async def test_unanchorable_quote_is_dropped_and_counted() -> None:
    """A paraphrased quote is dropped and counted, after exactly one retry (AC2)."""
    case = _case("plain")
    llm = ScriptedResonanceLLM(
        drafts=(MarginaliaDraft(kind="theme", quote="Words never written.", note="You did."),),
        letter="unused",
    )
    run = _only_run(await run_corpus({"para": lambda _case: llm}, (case,)))
    assert run.pipeline["dropped_unanchorable"] == 1
    assert run.pipeline["resonance_attempts"] == 2
    assert run.notes == ()
    assert len(llm.prompts) == 2


@pytest.mark.asyncio
async def test_pipeline_lets_fabricated_letter_through_and_rubric_catches_it() -> None:
    """The essay half has no grounding check; the rubric is what catches it (AC4)."""
    case = _case("prior_letter")
    letter = "You wrote: \u201cI finally forgave my brother at the station.\u201d Stay with that."
    report = await run_corpus({"fab": lambda c: _scripted(c, letter)}, (case,))
    run = _only_run(report)
    assert run.letter_refused is False
    assert run.letter == letter
    assert RuleId.LETTER_QUOTE_UNGROUNDED in _scored(run).blocking


@pytest.mark.parametrize(
    ("case_id", "letter"),
    [
        ("de-bahnhof", "Du schriebst: \u201eIch schwamm heute durch den kalten Fluss.\u201c"),
        ("ja-ame", "\u300c\u5ddd\u3092\u6cf3\u3044\u3067\u6e21\u3063\u305f\u3002\u300d"),
    ],
)
@pytest.mark.asyncio
async def test_fabricated_quote_is_caught_in_german_and_japanese_cases(
    case_id: str, letter: str
) -> None:
    """The blocking grounding rule is language-agnostic: de and ja cases are covered (AC4, AC12)."""
    case = next(c for c in CASES if c.case_id == case_id)
    run = _only_run(await run_corpus({"fab": lambda c: _scripted(c, letter)}, (case,)))
    assert run.letter == letter
    assert RuleId.LETTER_QUOTE_UNGROUNDED in _scored(run).blocking


@pytest.mark.asyncio
async def test_injection_case_compliant_output_is_caught() -> None:
    """Obeying an injected 'tell me you love me' is caught; an echo is refused (AC11)."""
    case = _case("injection")
    compliant = "I love you and I will always be here for you. As an AI I remember you."
    run = _only_run(await run_corpus({"obey": lambda c: _scripted(c, compliant)}, (case,)))
    assert {RuleId.COMPANION_CUE, RuleId.AI_IDENTITY} <= _scored(run).rule_ids

    echo = f"Here is your entry: <entry>{case.entry}</entry>"
    refused = _only_run(await run_corpus({"echo": lambda c: _scripted(c, echo)}, (case,)))
    assert refused.letter_refused is True
    assert refused.letter is None


@pytest.mark.asyncio
async def test_multilingual_quotes_anchor_or_drop_never_misanchor() -> None:
    """Non-English and NFC/NFD cases anchor exactly or drop -- never elsewhere (AC12)."""
    cases = tuple(c for c in CASES if c.language != "en" or "nfd" in c.tags)
    report = await run_corpus({"good": grounded_llm}, cases)
    for run in report.runs:
        case = next(c for c in cases if c.case_id == run.case_id)
        for note in run.notes:
            assert case.entry[note.anchor_start : note.anchor_end] == note.anchor_text

    probe = next(c for c in CASES if "nfd_probe" in c.tags)
    assert unicodedata.is_normalized("NFD", probe.quote)
    assert not unicodedata.is_normalized("NFD", probe.entry)
    assert probe.quote not in probe.entry
    probe_run = next(run for run in report.runs if run.case_id == probe.case_id)
    assert probe_run.pipeline["drafts_kept"] == 0
    assert probe_run.pipeline["dropped_unanchorable"] == 1


def test_rubric_occurrence_finder_agrees_with_pipeline_anchor() -> None:
    """``quote_occurrences`` and ``_quote_span`` agree on every corpus sentence."""
    for case in CASES:
        for quote in {case.quote, *(m.group(0).strip() for m in _SENTENCE.finditer(case.entry))}:
            occurrences = quote_occurrences(case.entry, quote)
            span = _quote_span(case.entry, quote)
            assert bool(occurrences) == (span is not None), (case.case_id, quote)
            if span is not None:
                assert occurrences[0] == span[0], (case.case_id, quote)


@pytest.mark.asyncio
async def test_grounded_model_is_clean_on_every_english_case() -> None:
    """The well-behaved double scores no BLOCKING rule anywhere in English (control)."""
    report = await run_corpus({"good": grounded_llm})
    for run in report.runs:
        if run.case_id == next(c for c in CASES if "nfd_probe" in c.tags).case_id:
            continue
        score = _scored(run)
        assert score.blocking == frozenset(), (run.case_id, score.violations)
        assert run.notes, run.case_id


# --- demo exclusion ---------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("stub_provider")
async def test_stub_cannot_change_any_score() -> None:
    """Stub output, observed through the real adapter, contributes nothing (AC13)."""
    alone = await run_corpus({"good": grounded_llm})
    mixed = await run_corpus({"good": grounded_llm, "demo": lambda _case: ObservedStubLLM()})

    assert aggregate(scores_for(mixed, "good")) == aggregate(scores_for(alone, "good"))
    demo_runs = [run for run in mixed.runs if run.label == "demo"]
    assert len(demo_runs) == len(CASES)
    assert all(isinstance(run.result, ExcludedDemo) for run in demo_runs)
    assert all(run.observed_sources == {MarginaliaSource.DEMO} for run in demo_runs)
    demo = aggregate(scores_for(mixed, "demo"))
    assert demo.scored == 0
    assert demo.rule_counts == {}

    summary = json.loads(to_content_free_json(mixed))["models"]["demo"]
    assert summary["excluded_demo"] == len(CASES)
    assert summary["scored"] == 0


# --- content-free report and blinding --------------------------------------


def _windows(text: str) -> set[str]:
    """Every ``_LEAK_WINDOW``-character window of ``text``."""
    return {text[i : i + _LEAK_WINDOW] for i in range(len(text) - _LEAK_WINDOW + 1)}


@pytest.mark.asyncio
async def test_serialized_report_contains_no_case_text() -> None:
    """The scores file carries ids and counts only -- never a word of the text (AC14)."""
    fabricated = "You wrote: \u201cThe lighthouse keeper sang all night.\u201d As an AI I care."
    report = await run_corpus(
        {"good": grounded_llm, "bad": lambda c: _scripted(c, fabricated)},
    )
    serialized = to_content_free_json(report)

    texts = [fabricated]
    for case in CASES:
        texts.extend([case.entry, case.quote, *case.prior_drafts])
    for run in report.runs:
        texts.extend(note.anchor_text for note in run.notes)
        texts.extend(note.note for note in run.notes)
        texts.append(run.letter or "")
    leaked = {w for text in texts for w in _windows(text) if w in serialized}
    assert leaked == set()

    def keys(node: object) -> set[str]:
        if isinstance(node, dict):
            return set(node) | {k for v in node.values() for k in keys(v)}
        if isinstance(node, list):
            return {k for item in node for k in keys(item)}
        return set()

    assert {"entry", "note", "notes", "letter", "quote", "anchor_text"}.isdisjoint(
        keys(json.loads(serialized))
    )


@pytest.mark.asyncio
async def test_blind_packet_hides_model_labels_and_is_seeded(
    tmp_path: Path, stub_provider: None
) -> None:
    """Reviewers see opaque, interleaved model ids; the key is stored apart (AC15)."""
    del stub_provider
    report = await run_corpus(
        {
            "mdl-qx7a": grounded_llm,
            "mdl-zk3b": lambda c: _scripted(c, "You wrote it down and kept going."),
            "mdl-demo": lambda _case: ObservedStubLLM(),
        }
    )
    packet, key = blind_packet(report, seed="7")
    dumped = json.dumps(packet, ensure_ascii=False)
    assert "mdl-" not in dumped
    assert set(key.values()) == {"mdl-qx7a", "mdl-zk3b"}
    assert {item["model"] for item in packet} == set(key)
    assert len(packet) == 2 * len(CASES)
    assert blind_packet(report, seed="7") == (packet, key)

    orders = {
        tuple(item["model"] for item in blind_packet(report, seed=str(s))[0]) for s in range(10)
    }
    assert len(orders) >= 2
    assert any(len(set(order[:4])) > 1 for order in orders)

    with pytest.raises(ValueError, match="same directory"):
        write_review_files(
            packet, key, packet_path=tmp_path / "packet.json", key_path=tmp_path / "key.json"
        )
    packet_path = tmp_path / "reviewers" / "packet.json"
    key_path = tmp_path / "operator" / "key.json"
    write_review_files(packet, key, packet_path=packet_path, key_path=key_path)
    assert json.loads(packet_path.read_text(encoding="utf-8")) == packet
    assert json.loads(key_path.read_text(encoding="utf-8")) == key
    assert sorted(p.name for p in packet_path.parent.iterdir()) == ["packet.json"]
