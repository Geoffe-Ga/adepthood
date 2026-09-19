// Days per APTITUDE stage: 8x21-day stages + 2x42-day stages = 36 weeks total.
export const STAGE_DURATIONS_DAYS = [21, 21, 21, 21, 21, 21, 21, 21, 42, 42] as const;

// Stages per SECTION of the course — the Red, Green and Ultraviolet turns of
// the Archetypal Wavelength (issue #2866). CROSS-STACK CONTRACT: mirrors
// ``STAGES_PER_SECTION`` in ``backend/src/domain/constants.py`` literal-for-
// literal, and is pinned against that file by a test, because the section's
// colour name is derived here from STAGE_ORDER while the backend derives the
// section's week span from the same number.
export const STAGES_PER_SECTION = 3;
