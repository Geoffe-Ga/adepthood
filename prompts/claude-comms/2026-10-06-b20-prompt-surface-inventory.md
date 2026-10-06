# DRAFT for the owner: prompt, offer and nudge surfaces by depth ring (#3073, AC14)

Status: **draft for Geoff's review.** This records what is true in the code
after the "honour declined depths" change on #3073. It is not a product
decision. The open questions at the end are the owner's.

"Gate" names the depth ring whose toggle (`UserDepthPreferences.enable_*`, mirrored
client-side by `useDepthPreferencesStore`) silences the surface. "Decline
persistence" says where a one-off "not now" or "never" answer is stored. **Device**
means AsyncStorage on this install: it does not follow the account to another
device or a reinstall, and a second account on the same device inherits it (P10).

## Server-generated surfaces

| Surface | Where | Gate after #3073 | Decline persistence |
|---|---|---|---|
| Habit consistency invitation | `services/invitations.py` -> `InvitationStack` | habits (generation and listing) | server: `InvitationSignal.dismissed_at` |
| Practice mastery invitation | same | practices | server: `InvitationSignal.dismissed_at` |
| Course readiness invitation (corpus theme) | same, needs a vault wheel read | course (and the wheel is never dialled with course off) | server: `InvitationSignal.dismissed_at` |
| Embodied community / sangha invitation | same | sangha | server: `InvitationSignal.dismissed_at` |
| Contraction ("foundation easing off") reflection | `routers/journal.py` `_contraction_reflection` -> `ContractionReflectionNote` | habits (server returns `null`; client mount also gated) | none: it is computed on each resonance pass |
| Completion suggestions inside resonance | `routers/journal.py` resonance detection -> `CompletionSuggestionNote` | **ungated (next slice, AC17)**: habit and practice names still go into detection with a ring off | server: suggestion dismiss |

A declined ring keeps its stored invitation rows. They are hidden while the ring
is off and listed again when it is turned back on. A dismissed row stays
dismissed in both states.

## Client-composed surfaces

| Surface | Component | Gate after #3073 | Decline persistence |
|---|---|---|---|
| Return (soft-landing offer, arc, resting habits) | `features/Return/ReturnStack.tsx`, mounted on the shelf | habits (mount gated) | device: `@adepthood/return_offer_dismissed` |
| Keep a finished writing session as a habit or a practice | `features/Journal/WritingSessionOffer.tsx` | habits for the habit accept, practices for the practice accept; no offer when both are off | device: `@adepthood/writing_habit_offer_answered` (plus the server writing-habit link as an answer) |
| Link-a-habit pointer after a session | `features/Journal/LinkHabitNudge.tsx` | habits (both mounts gated) | device: `@adepthood/link_habit_nudge_never_offer` |
| Contraction reflection note | `features/Journal/ContractionReflectionNote.tsx` | habits (mount gated) | none |
| Stat tiles | `features/Journal/StatTileRow.tsx` | habits / practices (already gated before #3073) | n/a |
| Drawer and tab destinations | `navigation/BottomTabs.tsx`, `components/drawer/DrawerNavSection.tsx` | habits / practices / course (already gated) | n/a |
| Digital Sangha door | `features/Settings/SanghaSection.tsx` | sangha (already gated) | n/a |
| Stage prompts band | `JournalShelfScreen.tsx` `StagePromptSection` | **ungated (next slice)**: program-stage prompts are journaling prompts, but they speak in the course's stage vocabulary | server: prompt set-aside |
| Weekly / stage / section / course review invitation | `JournalPrimaryInvitation.tsx` -> `ReflectionInvitationBand.tsx` | **ungated (next slice)**: is a Course or Section review part of the course ring? | device: `@adepthood/reflection_dismissed:<scope>` |
| Morning-pages tip | `MorningPagesTip.tsx` | none (journal floor) | device: `@adepthood/morning_pages_tip_dismissed`, `@adepthood/morning_pages_tip_set_aside_on` |
| Corpus invitation after a reflection | `CorpusInvitationNote.tsx` | consent, not a ring | server: corpus invitation state |
| Voice-readiness band | `VoiceReadinessBand.tsx` | none (journal floor) | device: `@adepthood/voice_readiness_dismissed` |
| Promote-quote explainer | `usePromoteExplainer.ts` | none (journal floor) | device: `@adepthood/promote_explainer_dismissed` |
| Resonance spend disclosure | `useResonanceExplainer.ts` | none (a disclosure, not an offer) | device: `@adepthood/resonance_explainer_dismissed` |

## Next code slices (not escalated)

- **AC15.** Move the device-only declines above to account-scoped server storage
  (`UserUiFlags` or a decline table). Migrate existing device flags up on first
  login, and never turn a decline back into an offer.
- **AC16.** Decide and test what a deep link to a declined ring's screen does.
- **AC17.** Leave habit names out of resonance completion detection when habits
  are off, and practice names when practices are off.

## Questions for the owner

1. Defaults: should new accounts start opted in (today) or opted out of each
   ring (AC18, AC19)?
2. Are the stage prompts band and the course or section review invitation part
   of the course ring, or part of the journal floor?
3. With habits off, the Return surface is hidden for a user whose Return arc is
   already running. Is that the intended quieting, or should a running arc stay
   visible until it ends?
