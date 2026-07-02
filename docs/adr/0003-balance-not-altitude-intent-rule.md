# ADR 0003: "Balance, not altitude" is an intent rule, not a wordlist

- **Status:** Accepted
- **Date:** 2026-07-01
- **Issue:** [#945](https://github.com/Geoffe-Ga/adepthood/issues/945) (epic
  [#943](https://github.com/Geoffe-Ga/adepthood/issues/943);
  owner-ratified in-body 2026-06-30, wavelength-vs-cycle framing via
  [#1004](https://github.com/Geoffe-Ga/adepthood/issues/1004))

## Context

`NORTH-STAR.md` section 5 says the Map should read as balance across
the ten Aspects of Wholeness — "which facets are full, which are
thin, where you are out of balance" — and explicitly "never as an
altitude you have climbed." Issue #915's acceptance criteria took
that sentence literally and banned a flat list of words from Map
copy: "level, climb, ascend, higher, rank."

That literal reading collides with the course's own source material.
The Archetypal Wavelength genuinely rises — epic #943 keeps its
upward shape by design — and the teachings speak plainly of "higher
frequencies" and "higher Stages." A wordlist ban forbids the course
from describing itself honestly.

The owner ratified the resolution in-body on 2026-06-30. In their own
words, the Stages "are systems that you have to bring online and get
tuned properly with balance and temperance — not a one-way ladder."
They often overlap with developmental models such as Spiral Dynamics
or Growing Up frameworks, but that overlap does not make them a
one-way ladder — a person is never "ahead of" or "behind" another
person, only more or less balanced across the ten Aspects right now.

## Decision 1 — "Not altitude" bans ranking, not vocabulary

"Never as an altitude you have climbed" means don't rank or shame the
person or the Stages relative to each other — it does not mean hide
the ascending model. Describing the model in its own ascending terms
("higher frequencies," "rising wavelength," "Stage 10 / Emptiness")
is fine when it describes the *territory* and the *systems coming
online*, never the worth or rank of the traveler.

**Rejected — banning "higher" outright:** this would force Map and
course copy to euphemize language the source material uses plainly,
which is dishonest and unnecessary.

## Decision 2 — The banned-vocabulary criterion becomes an intent rule

#915's flat wordlist is replaced with an intent rule. Forbidden: copy
that ranks or shames the user or implies they are behind or inferior
— "you're only at level 3," "climb to unlock," streak-shame,
leaderboards, any framing that compares one person's progress against
another's. Permitted: describing the model itself in its own
ascending terms when the sentence is about the territory or the
systems coming online, not about the user's worth.

**Rejected — keeping a flat wordlist with exceptions bolted on:** an
ever-growing exception list is harder to reason about and harder to
test than a single, clear intent rule.

## Decision 3 — Wavelength vs. cycle

The framing that makes this precise, to be used verbatim wherever the
distinction needs stating:

"a wavelength is a trajectory through time; a cycle is the same shape
with time removed and the arrows looping back."

This is the crisp way to keep the upward shape — a rising wave — of
the Archetypal Wavelength (#943) without it reading as a closed,
shaming loop. It also cleanly distinguishes this Map's rising wave
from the Stage-10-to-1 restart loop (#916): the wavelength is a
trajectory through time, always moving forward through a fresh pass;
the cycle is that same shape with the time axis removed, so the same
territory keeps recurring rather than accusing the user of going
"back down."

## Rejected

- **Keep the flat wordlist as-is.** It would forbid the course's own
  honest language about higher frequencies and higher Stages,
  producing copy that contradicts the teachings it is meant to
  present.
- **Hide the ascending model entirely.** Scrubbing all upward language
  from the Map and course would misrepresent the Archetypal
  Wavelength, which is genuinely and intentionally a rising model
  (#943). That is dishonest to the source material.

## Consequences

- No runtime behavior changes. This is a documentation and
  copy-review decision.
- The Map's banned-words tests assert that ranking and shaming
  phrases are absent, rather than blanket-banning "higher" and its
  neighbors.
- This unblocks #944, #947, and #948, whose copy needed the course's
  own ascending vocabulary to describe Stages and frequencies
  accurately.
- This keeps #913 honest: the Map can say a facet is "thin" or "full"
  and the course can say a Stage is "higher" without either implying
  the user is ranked against anyone else.
- **This ADR supersedes the banned-vocabulary (flat-wordlist) clause
  of #915.**
