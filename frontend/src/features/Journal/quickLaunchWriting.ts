/**
 * Launching a saved ``Journaling`` practice straight into a timed writing page.
 *
 * One pure function over what the practice player has already resolved. It
 * decides three things and nothing else: whether there is anything to offer,
 * how long the timer should open at, and whether the finished session can be
 * counted. Everything it needs is passed in, so the decision is testable at its
 * boundaries and the screen that renders the button holds no rules of its own.
 *
 * ## Where the length comes from, and why it is not one field
 *
 * The seeded ``Journaling`` row is ``count_up``
 * (``backend/src/seed_practices.py::_COUNT_UP_ALTERNATIVE_SPECS``), and
 * ``CountUpConfig`` carries no ``duration_minutes`` at all — the mode is
 * open-ended by definition. So "read the duration off the effective config" is
 * not, on its own, a rule that can be followed for this practice: the effective
 * config has no duration to read.
 *
 * What survives from that rule is the part that matters, and it is the lesson
 * of #933: whatever the writer edited must win over whatever the catalogue
 * shipped. So the config is read FIRST, in both the forms a config can express
 * a length — a timed mode's ``duration_minutes``, or a count_up's
 * ``soft_cap_minutes``, which is the only length that mode has — and only a
 * config that declares neither falls through to the catalogue row's own
 * ``default_duration_minutes`` (20 for ``Journaling``, chosen to match the
 * writing page). The writing page's own default is the last resort, reached
 * only by a practice that declares no length anywhere.
 *
 * ## Why a locked stage still launches
 *
 * ``POST /practice-sessions/`` refuses a session logged against a stage the
 * writer has not reached (403 ``stage_locked``), while the selection itself is
 * deliberately allowed there — the server calls that forward planning. The
 * writing page is the floor of this product and is never gated, so the launch
 * happens either way; what it carries is a selection to count against, or
 * ``null``, and the surface says which before the tap rather than discovering
 * the refusal afterwards. This is the same split ``keepAsPractice`` already
 * makes for the same reason.
 */
import { JOURNALING_PRACTICE_NAME } from './saveAsPracticeCopy';
import { DEFAULT_WRITING_MINUTES } from './writingSession';

import type { ModeConfig } from '@/features/Practice/engine/types';

/** What the practice player has resolved, as this decision needs it. */
export interface QuickLaunchInput {
  /** The catalogue row behind the active selection, or ``null`` when unresolved. */
  readonly practice: { readonly name: string; readonly default_duration_minutes: number } | null;
  /** The writer's open selection for the stage on view, or ``null``. */
  readonly activeUserPractice: { readonly id: number; readonly stage_number: number } | null;
  /** The config the player actually drives — the per-user override first. */
  readonly effectiveConfig: ModeConfig | null;
  /** How far the writer's own programme has opened, whatever stage is on view. */
  readonly openedStage: number;
}

/** A timed writing page, ready to be opened. */
export interface WritingQuickLaunch {
  /** The length the timer opens at, and starts running at, in minutes. */
  readonly minutes: number;
  /**
   * The selection the finished session is recorded against, or ``null`` when
   * the stage is not open to the writer yet and nothing can be counted.
   */
  readonly userPracticeId: number | null;
}

/**
 * The length a config declares, in whichever way its mode can declare one.
 *
 * @param config - The effective config, or ``null`` when none resolved.
 * @returns The declared minutes, or ``null`` when the mode declares none.
 */
function configuredMinutes(config: ModeConfig | null): number | null {
  if (config === null) return null;
  if ('duration_minutes' in config) return config.duration_minutes;
  if (config.mode === 'count_up') return config.soft_cap_minutes ?? null;
  return null;
}

/**
 * The first positive length among the config, the catalogue row, and the page.
 *
 * A zero or negative length is treated as no length at all rather than honoured:
 * a timer set to open at zero has nothing to run, and the writing page's own
 * default is a better answer than a session that ends the instant it starts.
 *
 * @param config - The effective config the player drives.
 * @param catalogueMinutes - The catalogue row's own nominal length.
 * @returns The minutes the timer opens at.
 */
function launchMinutes(config: ModeConfig | null, catalogueMinutes: number): number {
  const candidates = [configuredMinutes(config), catalogueMinutes, DEFAULT_WRITING_MINUTES];
  return (
    candidates.find((value): value is number => value !== null && value > 0) ??
    DEFAULT_WRITING_MINUTES
  );
}

/**
 * What, if anything, the writer's saved practice launches into.
 *
 * @param input - What the practice player resolved for the stage on view.
 * @returns The launch, or ``null`` when there is nothing to offer — which is
 *   every writer who has not saved ``Journaling`` as a practice, so the
 *   affordance is never dead chrome.
 */
export function planQuickLaunch({
  practice,
  activeUserPractice,
  effectiveConfig,
  openedStage,
}: QuickLaunchInput): WritingQuickLaunch | null {
  if (practice === null || activeUserPractice === null) return null;
  if (practice.name !== JOURNALING_PRACTICE_NAME) return null;
  const opened = openedStage >= activeUserPractice.stage_number;
  return {
    minutes: launchMinutes(effectiveConfig, practice.default_duration_minutes),
    userPracticeId: opened ? activeUserPractice.id : null,
  };
}
