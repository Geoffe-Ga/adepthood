/**
 * The session view each mode mounts, by its root `testID`. Shared by the
 * preset launch matrix and the backend mode-parity guard so a mode added to
 * one and not the other cannot slip through. The mapped type makes a mode
 * with no entry a type error.
 */
import type { ModeConfig } from '../engine/types';

export const SESSION_VIEW_TEST_IDS: { [K in ModeConfig['mode']]: string } = {
  meditation_timer: 'meditation-timer-view',
  count_up: 'count-up-timer-view',
  metronome: 'metronome-view',
  interval_bell: 'interval-bell-view',
  random_interval_bell: 'random-interval-bell-view',
  rep_counter: 'rep-counter-view',
  sense_grounding: 'sense-grounding-view',
  tallied_grounding: 'tallied-grounding-view',
  tarot: 'tarot-meditation-view',
  card_meditation: 'card-meditation-view',
  mindful_anchor: 'mindful-anchor-view',
};
