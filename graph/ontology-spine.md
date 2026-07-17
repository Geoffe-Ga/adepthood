---
ontology_version: aptitude-wavelength/2026-05-23
dataset_version: "2.0.0"
---

# APTITUDE / Archetypal Wavelength -- Ontology Spine

Human-readable and machine-extractable canon for the ten APTITUDE Stages,
their six-phase Archetypal Wavelength manifestations, and the Creek Vault
concepts adepthood's journal seam depends on. The same territory is
described under different local names across five ecosystem repositories
(adepthood, aptitude-course, Creek Vault, wavelength-demo, WavelengthWatch);
this document pins the shipped, dataset-backed values as canonical and
records every other repo's name for the same thing as an alias.

Every entity below carries a `#### Aliases` line: an inline, `=`-joined list
of every name that entity is known by across the ecosystem. A graph
extractor should resolve every name on an Aliases line onto the same node.

## Sources

- `backend/src/curriculum/archetypal_wavelength.json` (dataset_version 2.0.0) -- the vendored source of truth for the 10 Stages and their 6-phase manifestations.
- `backend/content/markdown/NN-color/` chapters (e.g. `08-teal/`) -- each Stage's Mode ("The Mode of the Wavelength of ...").
- `frontend/src/design/tokens.ts` -- Stage color hex (`STAGE_COLORS`) and the legacy Turquoise -> Teal alias (`LEGACY_STAGE_ALIASES`).
- `docs/curriculum.md` -- provenance: `stage_attributes_source` = APTITUDE Complete Map.csv (aptitude-course repo), `manifestations_source` = Archetypal Wavelength "Expanded List" sheet; Rx = integrated, OD = shadow.
- `NORTH-STAR.md` -- the Aspects of Wholeness (the ten gifts). Adepthood's Aspects and Creek's Frequencies name the same ten developmental positions (Stages); `docs/creek-vault-mcp-contract.md` frames Aspects, Frequencies, and the Wavelength as "one vocabulary under three names." The six Wavelength *phases* below are the distinct cyclic axis, not those ten positions.
- Creek-Vault repo `docs/Ontology/creek_ontology_agent_prompt.md` (public) section 2.1 (primitives), 6.1 (Frequencies), 7 (Modes + Medicine/Toxic). Version anchor `aptitude-wavelength/2026-05-23` from Creek-Vault `docs/decisions/2026-05-23-frequency-naming.md`.

**Field provenance.** Per-Stage `archetype` is the dataset's `relationship_to_free_will`; `gift` is the dataset's `aspect` (an Aspect of Wholeness); `shadow` is the overdose tendency paraphrased from `free_will_description`, or from a shadow (OD) manifestation where that field carries no shadow language. Derived, curated fields -- not literal JSON keys.

## Stages

### Stage 1 -- Beige

- Color `#d8cbb8` | Category Yes-And-Ness | Gift Agency | Growing-Up Survival | Divine gender Divine Masculine
- Mode Inhabit (Do) | Archetype Biological Machine | Frequency F1 Agency
- Shadow: "purely reactive and instinctual, driven by basic survival needs"
- Source: `archetypal_wavelength.json` stage 1; `tokens.ts`; `backend/content/markdown/01-beige/05-the-vibe-wavelength-of-beige-internalize-do.md`.

#### Aliases

Beige = Stage 1 = F1 = BEIGE = 01-beige = Survival

### Stage 2 -- Purple

- Color `#a093c6` | Category Yes-And-Ness | Gift Receptivity | Growing-Up Magic | Divine gender Divine Feminine
- Mode Inhabit (Feel) | Archetype Archetype Embodier | Frequency F2 Receptivity
- Shadow: personality as "the combined effort of archetypal role models," from fictional characters to celebrities, rather than chosen
- Source: `archetypal_wavelength.json` stage 2; `tokens.ts`; `backend/content/markdown/02-purple/05-the-vibe-wavelength-of-purple-internalize-feel.md`.

#### Aliases

Purple = Stage 2 = F2 = PURPLE = 02-purple = Magick

### Stage 3 -- Red

- Color `#cc5b5b` | Category Love | Gift Self-Love | Growing-Up Ego-centrism | Divine gender Divine Masculine
- Mode Express (Do) | Archetype Dominator | Frequency F3 Self-Love / Power
- Shadow: without self-love, "the tendency is to forge dominator power over others"
- Source: `archetypal_wavelength.json` stage 3; `tokens.ts`; `backend/content/markdown/03-red/05-the-vibe-wavelength-of-red-externalize-do.md`.

#### Aliases

Red = Stage 3 = F3 = RED = 03-red = Power = Self-Love / Power

### Stage 4 -- Blue

- Color `#6fa3d3` | Category Love | Gift Community Love | Growing-Up Conformity | Divine gender Divine Feminine
- Mode Express (Feel) | Archetype Victim | Frequency F4 Community Love / Conformity
- Shadow: "we are defined by roles: partners, parents, children, coworkers, friends, pupils"
- Source: `archetypal_wavelength.json` stage 4; `tokens.ts`; `backend/content/markdown/04-blue/05-the-vibe-wavelength-of-blue-express-feel.md`.

#### Aliases

Blue = Stage 4 = F4 = BLUE = 04-blue = Conformity = Community Love / Conformity

### Stage 5 -- Orange

- Color `#f29f67` | Category Understanding | Gift Intellectual Understanding | Growing-Up Achievest | Divine gender Divine Masculine
- Mode Collaborate (Do) | Archetype Status Seeker | Frequency F5 Achievism
- Shadow: "chasing things valued by the culture: money, wealth, status, privilege, fame" -- achievement, with free will left unconsidered
- Source: `archetypal_wavelength.json` stage 5; `tokens.ts`; `backend/content/markdown/05-orange/05-the-vibe-wavelength-of-orange-collaborate-do.md`.

#### Aliases

Orange = Stage 5 = F5 = ORANGE = 05-orange = Achievist = Achievism

### Stage 6 -- Green

- Color `#6fcf97` | Category Understanding | Gift Embodied Understanding | Growing-Up Pluralistic | Divine gender Divine Feminine
- Mode Collaborate (Feel) | Archetype Shadow Glorifier | Frequency F6 Pluralism
- Shadow: "Free Will is still absent as behavior follows predictably from a set of pluralistic heuristics"
- Source: `archetypal_wavelength.json` stage 6; `tokens.ts`; `backend/content/markdown/06-green/05-the-vibe-wavelength-of-green-collaborate-feel.md`.

#### Aliases

Green = Stage 6 = F6 = GREEN = 06-green = Pluralist = Pluralism

### Stage 7 -- Yellow

- Color `#f2e96d` | Category Wisdom | Gift Systems Wisdom | Growing-Up Integrative | Divine gender Divine Masculine
- Mode Integrate (Do) | Archetype Despairing Analyst | Frequency F7 Integration
- Shadow: "becomes convinced that Free Will is essentially an illusion"
- See Known Conflicts -- the manifest chapters carry a differing ontology for this Stage.
- Source: `archetypal_wavelength.json` stage 7; `tokens.ts`; `backend/content/markdown/07-yellow/06-the-vibe-wavelength-of-yellow-integrate-do.md`.

#### Aliases

Yellow = Stage 7 = F7 = YELLOW = 07-yellow = Integrative = Integration

### Stage 8 -- Teal

- Color `#50c9c3` | Category Wisdom | Gift True Self Connection | Growing-Up Nonduality | Divine gender Divine Feminine
- Mode Integrate (Feel) | Archetype True Self Embodier | Frequency F8 True Self / Transcendence
- Shadow: `free_will_description` carries no shadow language (it describes the integrated path only); representative OD, Peaking: "Obsession -- the subtle grasp of preferring the state to continue"
- Legacy: this Stage was named Turquoise before the Dec-2025 supersession (settled, see Known Conflicts).
- See Known Conflicts -- the manifest chapters carry a differing category for this Stage.
- Source: `archetypal_wavelength.json` stage 8; `tokens.ts` (`LEGACY_STAGE_ALIASES`); `backend/content/markdown/08-teal/05-the-vibe-wavelength-of-teal-integrate-feel.md`.

#### Aliases

Teal = Stage 8 = F8 = TEAL = 08-teal = Nondual = Turquoise (legacy) = True Self / Transcendence

### Stage 9 -- Ultraviolet

- Color `#8e44ad` | Category Being | Gift Unity | Growing-Up Effortless Being | Divine gender Divine Hermaphrodite
- Mode Absorb (Do/Feel) | Archetype Blissy Adept | Frequency F9 Unity
- Shadow: the goal becomes to "subsume individual Will into alignment with the Will of Source" -- blissful union of Atman and Brahman
- See Known Conflicts -- the manifest chapters carry a differing ontology for this Stage.
- Source: `archetypal_wavelength.json` stage 9; `tokens.ts`; `backend/content/markdown/09-ultraviolet/05-the-vibe-wavelength-of-ultraviolet-absorb-do.md`.

#### Aliases

Ultraviolet = Stage 9 = F9 = ULTRAVIOLET = 09-ultraviolet = Effortless Being = Unity

### Stage 10 -- Pure Awareness (Clear Light)

- Color `#ffffff` | Category Awareness | Gift Emptiness | Growing-Up Pure Awareness | Divine gender Divine Hermaphrodite
- Mode Be (Both/Neither) | Archetype Whole Adept | Frequency F10 Emptiness
- Shadow: "there is no longer an individual who can have Free Will"; the body becomes "an empty Nobody" who simply does the perfect thing
- See Known Conflicts -- the manifest chapters carry a differing ontology for this Stage.
- Source: `archetypal_wavelength.json` stage 10; `tokens.ts`; `backend/content/markdown/10-clearlight/05-the-vibe-wavelength-of-clear-light-be-neitherall.md`.

#### Aliases

Clear Light = Stage 10 = F10 = CLEAR LIGHT = 10-clearlight = Pure Awareness = Emptiness

## Wavelength Phases

Source for all six: `backend/src/curriculum/archetypal_wavelength.json` (`phases`); narrative lines from Creek-Vault `docs/Ontology/creek_ontology_agent_prompt.md` section 7.1.

### Rising

The upswing where returning energy first becomes available to act on. Narrative: "Abundance begins to create Indulgence."

#### Aliases

Rising = Phase 1

### Peaking

The high point, where the available energy is fullest and most expressed. Narrative: "Abundance peaks."

#### Aliases

Peaking = Phase 2

### Withdrawal

Energy recedes from its peak -- the first pull back toward baseline. Narrative: "Indulgence creates Scarcity."

#### Aliases

Withdrawal = Phase 3

### Diminishing

The recession continues; less energy is available than before. Narrative: "Scarcity begins to create Resilience."

#### Aliases

Diminishing = Phase 4

### Bottoming Out

The low point, where the least energy is available. Narrative: "Scarcity peaks."

#### Aliases

Bottoming Out = "Bottoming-Out" = Phase 5

### Restoration

The return leg, rebuilding energy back toward Rising; closes the cycle rather than opening a new one. Narrative: "Resilience creates Abundance."

#### Aliases

Restoration = Phase 6 = the return phase

## Dose Axis

Medicine and Toxic are opposite poles of one axis, so they resolve to two
distinct nodes -- each carries its own Aliases line below.

### Medicine (Rx)

The integrated, right-sized manifestation of a Stage at a given Wavelength phase -- what a person expresses when that phase's energy is met skillfully.

#### Aliases

Medicine = Rx = integrated = right-sized

### Toxic (OD)

The shadow, overdosed manifestation of the same Stage/phase pairing -- the same energy expressed in an unintegrated or excessive form.

#### Aliases

Toxic = OD = shadow = overdose

### Leaf structure

Leaf structure: 10 Stages x 6 Phases x 2 doses = 120 manifestation leaves. Adepthood's authoritative leaf names live in `backend/src/curriculum/archetypal_wavelength.json` (`manifestations[].integrated` = Rx, `manifestations[].shadow` = OD), per `docs/curriculum.md`. Leaf names differ across ecosystem repos (e.g. Creek-Vault section 7.3 uses its own naming); the vendored dataset is adepthood's source of truth.

## Creek Primitives

Source: Creek-Vault `docs/Ontology/creek_ontology_agent_prompt.md` section 2.1.

### Fragment

The atomic unit of meaning drawn from any source; gains meaning only through its connections to other Fragments.

#### Aliases

Fragment

### Resonance

A semantic or thematic echo between two Fragments; a link.

#### Aliases

Resonance = link

### Thread

A temporal narrative or thematic current running across Fragments; a Thread has direction.

#### Aliases

Thread

### Eddy

A cluster of Fragments pooling around a topic; discovered, not created.

#### Aliases

Eddy = cluster = collection

### Praxis

An actionable insight, practice, or decision derived from a pattern across Fragments.

#### Aliases

Praxis

## Frequencies

| Frequency | Name (Creek section 6.1) | Color | Stage | Aspect/Gift |
| --- | --- | --- | --- | --- |
| F1 | Agency | Beige | 1 | Agency |
| F2 | Receptivity | Purple | 2 | Receptivity |
| F3 | Self-Love / Power | Red | 3 | Self-Love |
| F4 | Community Love / Conformity | Blue | 4 | Community Love |
| F5 | Achievism | Orange | 5 | Intellectual Understanding |
| F6 | Pluralism | Green | 6 | Embodied Understanding |
| F7 | Integration | Yellow | 7 | Systems Wisdom |
| F8 | True Self / Transcendence | Teal | 8 | True Self Connection |
| F9 | Unity | Ultraviolet | 9 | Unity |
| F10 | Emptiness | Clear Light | 10 | Emptiness |

- F5's Creek name "Achievism" differs from adepthood's aspect name "Intellectual Understanding" for the same Stage.
- F8's Creek name is "True Self / Transcendence"; Creek's color listing reads "Teal/Turquoise" where adepthood's canon (post Dec-2025 supersession) is Teal only -- see Known Conflicts.
- F9 "Unity" (Ultraviolet) matches adepthood's aspect name exactly.

Source: Creek-Vault `docs/Ontology/creek_ontology_agent_prompt.md` section 6.1; `backend/src/curriculum/archetypal_wavelength.json`.

#### Aliases

F1 = Frequency 1 = Agency = Beige = Stage 1
F2 = Frequency 2 = Receptivity = Purple = Stage 2
F3 = Frequency 3 = Self-Love / Power = Red = Stage 3
F4 = Frequency 4 = Community Love / Conformity = Blue = Stage 4
F5 = Frequency 5 = Achievism = Orange = Stage 5
F6 = Frequency 6 = Pluralism = Green = Stage 6
F7 = Frequency 7 = Integration = Yellow = Stage 7
F8 = Frequency 8 = True Self / Transcendence = Teal = Stage 8
F9 = Frequency 9 = Unity = Ultraviolet = Stage 9
F10 = Frequency 10 = Emptiness = Clear Light = Stage 10

## Known Conflicts

The Stage attribute values shipped above come from `APTITUDE Complete Map.csv` (the dataset's `stage_attributes_source`, per `archetypal_wavelength.json` and `docs/curriculum.md`). The vendored course manifest chapters under `backend/content/markdown/` carry a DIFFERING ontology for Stages 7-10. This document does not resolve that difference; it is recorded here neutrally as an open decision (#1637, epic:stage-ontology):

- Stage 7: Category Wisdom vs. manifest "Freedom" (`backend/content/markdown/07-yellow/02-the-mood-of-yellow-freedomfree-will.md`); Archetype Despairing Analyst vs. manifest "Intentional Actor" (`backend/content/markdown/07-yellow/05-the-relationship-to-free-will-at-yellow-intentional-actor.md`); Aspect Systems Wisdom vs. manifest "Free Will".
- Stage 8: Category Wisdom vs. manifest "Freedom" (`backend/content/markdown/08-teal/02-the-mood-of-teal-freedomtrue-self-connection.md`).
- Stage 9: Category Being vs. manifest "Wholeness"; Aspect Unity vs. manifest "Developmental Complexity"; Archetype Blissy Adept vs. manifest "Hierarchical Organizer" (`backend/content/markdown/09-ultraviolet/02-the-mood-of-ultraviolet-wholenesshierarchy.md`).
- Stage 10: Category Awareness vs. manifest "Wholeness"; Archetype Whole Adept vs. manifest "Adept" (`backend/content/markdown/10-clearlight/02-the-mood-of-clear-light-wholenessemptiness.md`).

This document pins the shipped dataset values above as canonical. The reconciliation is tracked in the open stage-ontology decision (#1637); until it lands, a semantic-extraction pass should treat both name-sets as aliases of the same Stage entity rather than choosing a side.

By contrast, Stage 4's aspect "Community Love" and Stage 8's color Teal / aspect "True Self Connection" / archetype "True Self Embodier" are SETTLED Dec-2025 supersessions, not open conflicts -- see the `docs/curriculum.md` provenance block and the `aptitude-course` repository's `CLAUDE.md`.
