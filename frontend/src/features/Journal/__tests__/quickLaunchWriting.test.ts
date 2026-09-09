/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { planQuickLaunch } from '../quickLaunchWriting';
import { DEFAULT_WRITING_MINUTES } from '../writingSession';

import type { ModeConfig } from '@/features/Practice/engine/types';

/** Green, where the seeded ``Journaling`` row sits. */
const GREEN = 6;
/** The nominal length the seeded ``Journaling`` row carries. */
const SEEDED_MINUTES = 20;

const journaling = { name: 'Journaling', default_duration_minutes: SEEDED_MINUTES };
const selection = { id: 42, stage_number: GREEN };
/** What the seeder actually stores for ``Journaling`` — a count_up with no length. */
const SEEDED_CONFIG: ModeConfig = { mode: 'count_up', soft_cap_minutes: null };

describe('planQuickLaunch — who is offered a timed page at all', () => {
  it('offers nothing when the writer has no active selection', () => {
    expect(
      planQuickLaunch({
        practice: journaling,
        activeUserPractice: null,
        effectiveConfig: SEEDED_CONFIG,
        openedStage: GREEN,
      }),
    ).toBeNull();
  });

  it('offers nothing when the active practice is something other than Journaling', () => {
    expect(
      planQuickLaunch({
        practice: { name: 'Loving-kindness', default_duration_minutes: 30 },
        activeUserPractice: selection,
        effectiveConfig: SEEDED_CONFIG,
        openedStage: GREEN,
      }),
    ).toBeNull();
  });

  it('offers nothing when the catalogue row behind the selection is unresolved', () => {
    expect(
      planQuickLaunch({
        practice: null,
        activeUserPractice: selection,
        effectiveConfig: SEEDED_CONFIG,
        openedStage: GREEN,
      }),
    ).toBeNull();
  });

  it('offers a launch when Journaling is the writer’s active practice', () => {
    expect(
      planQuickLaunch({
        practice: journaling,
        activeUserPractice: selection,
        effectiveConfig: SEEDED_CONFIG,
        openedStage: GREEN,
      }),
    ).toEqual({ minutes: SEEDED_MINUTES, userPracticeId: selection.id });
  });
});

describe('planQuickLaunch — the length the timer opens at', () => {
  /**
   * The regression guard #933 left behind: an edit to the practice's duration
   * has to reach the timer, so the override is read before anything else.
   */
  it('takes the per-user override over the catalogue length', () => {
    const plan = planQuickLaunch({
      practice: journaling,
      activeUserPractice: selection,
      effectiveConfig: { mode: 'meditation_timer', duration_minutes: 30 },
      openedStage: GREEN,
    });

    expect(plan?.minutes).toBe(30);
  });

  /**
   * The seeded row is ``count_up``, whose config carries no ``duration_minutes``
   * at all — its only length is the soft cap, and that is what a writer who
   * sets one has asked the practice to be.
   */
  it('takes a count_up soft cap as the length when one is set', () => {
    const plan = planQuickLaunch({
      practice: journaling,
      activeUserPractice: selection,
      effectiveConfig: { mode: 'count_up', soft_cap_minutes: 45 },
      openedStage: GREEN,
    });

    expect(plan?.minutes).toBe(45);
  });

  it('falls back to the catalogue row’s own length when the config declares none', () => {
    const plan = planQuickLaunch({
      practice: { ...journaling, default_duration_minutes: 35 },
      activeUserPractice: selection,
      effectiveConfig: SEEDED_CONFIG,
      openedStage: GREEN,
    });

    expect(plan?.minutes).toBe(35);
  });

  it('falls back to the writing page’s own length only when the practice declares none', () => {
    const plan = planQuickLaunch({
      practice: { ...journaling, default_duration_minutes: 0 },
      activeUserPractice: selection,
      effectiveConfig: null,
      openedStage: GREEN,
    });

    expect(plan?.minutes).toBe(DEFAULT_WRITING_MINUTES);
  });
});

describe('planQuickLaunch — a stage the writer has not reached', () => {
  /**
   * ``POST /practice-sessions/`` refuses a session logged against a stage the
   * writer has not reached (403 ``stage_locked``), and the selection itself is
   * allowed there on purpose. So the launch still happens — the writing page is
   * the floor and is never gated — but it carries no selection to count against.
   */
  it('carries no selection to count against while Green is still ahead', () => {
    const plan = planQuickLaunch({
      practice: journaling,
      activeUserPractice: selection,
      effectiveConfig: SEEDED_CONFIG,
      openedStage: 1,
    });

    expect(plan).toEqual({ minutes: SEEDED_MINUTES, userPracticeId: null });
  });

  it('counts the session the moment the writer is standing at the stage itself', () => {
    const plan = planQuickLaunch({
      practice: journaling,
      activeUserPractice: selection,
      effectiveConfig: SEEDED_CONFIG,
      openedStage: GREEN,
    });

    expect(plan?.userPracticeId).toBe(selection.id);
  });

  it('counts the session for a writer who has gone past the stage', () => {
    const plan = planQuickLaunch({
      practice: journaling,
      activeUserPractice: selection,
      effectiveConfig: SEEDED_CONFIG,
      openedStage: GREEN + 1,
    });

    expect(plan?.userPracticeId).toBe(selection.id);
  });
});
