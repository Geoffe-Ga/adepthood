"""Hermetic reflection-quality evaluation harness (#3074, slice 1).

Scores what the resonance pipeline hands a writer -- margin notes and the
letter one of them expands into -- against a rubric of named rules. The two
questions it answers are whether the reflection is *grounded* (every quote is
the writer's own words, anchored where the writer wrote them) and whether it is
*non-anthropomorphic* (no AI self-identity, invented shared memory, companion
or guru cues, medical direction, or promises of healing).

Ground rules, all load-bearing:

* **Invented text only.** Every entry in :mod:`tests.reflection_eval.corpus`
  is synthetic. No real journal, no production export, and nothing a person
  wrote may be added to the corpus or to a fixture here.
* **No network.** Nothing in this package makes a provider call. The models it
  scores are scripted doubles or the in-process stub. Paid live runs are an
  owner action and belong to the armed ``tests/live`` lane (``LIVE_RESONANCE_CHECK``),
  never to this package.
* **Demo output is never scored.** A reflection any part of which the stub
  answered (B07 receipt ``source=demo``) is recorded as excluded and counts for
  nothing (:data:`tests.reflection_eval.rubric.DEMO_SOURCES`).
* **The scores report is content-free.** It carries ids, rule ids and counts;
  reflection text exists only in the separately written blinded review packet.
* **The phrase detectors are English-only.** A case written in another language
  is routed to human review (``NEEDS_HUMAN_REVIEW``) rather than passed silently.
* **Severities are PROPOSED.** Which rules block a release is an owner decision
  (#3074 escalation 7); until it is ratified the rubric measures and gates
  nothing.

It lives under ``tests/`` because nothing in ``src`` calls it yet. If serve-time
enforcement lands (#3074 AC18), the release-blocking detectors move to
``src/domain/reflection_quality.py`` and this harness imports them from there.
"""
