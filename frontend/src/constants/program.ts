// Days per APTITUDE stage: 8x21-day stages + 2x42-day stages = 36 weeks total.
export const STAGE_DURATIONS_DAYS = [21, 21, 21, 21, 21, 21, 21, 21, 42, 42] as const;

// The whole 36-week program, in days.
export const TOTAL_PROGRAM_DAYS = STAGE_DURATIONS_DAYS.reduce((sum, d) => sum + d, 0);

// How far before account creation a person may say their program began (#3097).
// CROSS-STACK CONTRACT: mirrors ``PROGRAM_START_BACKDATE_WINDOW_DAYS`` in
// ``backend/src/domain/constants.py``. The client prefers the exact window the
// server sends on ``program_start_window`` and uses this only for the
// conservative offline fallback (today minus the window). Pinned against that
// file by ``stageOntologyDrift.test.ts`` (#3708), so a change to either side
// alone fails rather than letting the offline floor and the server disagree.
export const PROGRAM_START_BACKDATE_WINDOW_DAYS = TOTAL_PROGRAM_DAYS;

// Stages per SECTION of the course — the Red, Green and Ultraviolet turns of
// the Archetypal Wavelength (issue #2866). CROSS-STACK CONTRACT: mirrors
// ``STAGES_PER_SECTION`` in ``backend/src/domain/constants.py`` literal-for-
// literal, and is pinned against that file by a test, because the section's
// colour name is derived from this number (its closing stage's served colour,
// with STAGE_ORDER as the offline fallback -- ``store/stageColorName.ts``)
// while the backend derives the section's week span from the same number.
export const STAGES_PER_SECTION = 3;
