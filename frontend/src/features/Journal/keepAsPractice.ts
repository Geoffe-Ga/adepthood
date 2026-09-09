/**
 * Keeping a finished writing session as the ``Journaling`` practice.
 *
 * Two functions, deliberately apart: one that ASKS what keeping it would do,
 * and one that DOES it. The offer needs the first before it can describe the
 * choice honestly, and the writer needs to have read that description before
 * the second runs.
 *
 * ## Why this is not one call
 *
 * ``POST /user-practices/`` resolves a stage that is already held by closing
 * the open selection and inserting the new one — it does not refuse. So the
 * destructive case is invisible from the write's own result: by the time it
 * returns, the practice the writer chose has already been closed out. The only
 * place to catch it is before the tap, which is what ``planKeepAsPractice`` is
 * for.
 *
 * ## Why a locked stage is a client-side decision
 *
 * ``POST /practice-sessions/`` refuses a session logged against a stage the
 * writer has not reached (403 ``stage_locked``), while ``POST
 * /user-practices/`` deliberately ALLOWS the selection — the server's own
 * comment calls that forward planning, and says planning is not access. This
 * module keeps both: it selects at Green either way and simply does not
 * attempt the session log when the writer is below Green, so the flow never
 * offers a save that provokes a 403 it already knew was coming.
 *
 * Every failure resolves rather than throws. Nothing here is the writer's
 * fault, and the surface's job in every failing case is the same: say what is
 * true of their practices and leave the offer open.
 */
import { JOURNALING_PRACTICE_NAME } from './saveAsPracticeCopy';
import type { WritingSessionResult } from './writingSession';

import { practiceSessions, practices, stages, userPractices } from '@/api';
import { stageAtIndex } from '@/features/Habits/HabitUtils';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';
import { manualSessionPayload } from '@/features/Practice/utils/sessionWindow';

/**
 * Green, as a stage number.
 *
 * Six on both sides of the wire (``backend/src/domain/frequencies.py`` and
 * ``design/tokens.ts::STAGE_ORDER``), and the stage the seeded ``Journaling``
 * catalogue row sits at. The server refuses a selection whose ``stage_number``
 * disagrees with the catalogue row's (400 ``stage_number_mismatch``), so this
 * is not a default that can be varied per writer — it is the row's own stage.
 */
export const GREEN_STAGE_NUMBER = 6;

/** What keeping the session as a practice would do, resolved against the server. */
export interface PracticeOfferPlan {
  /** The seeded catalogue row to select. */
  readonly practiceId: number;
  /** The open selection at Green this would displace, or ``null``. */
  readonly displaces: string | null;
  /** The stage the writer is at when Green is not open to them yet, or ``null``. */
  readonly waitingAt: string | null;
}

/** What the write actually managed, which is not always all of it. */
export interface KeepPracticeOutcome {
  /** Whether ``Journaling`` is now a selected practice. */
  readonly kept: boolean;
  /** Whether the finished session was recorded against it. */
  readonly sessionLogged: boolean;
}

/** The elapsed writing this offer would record, and when it ended. */
export interface FinishedWriting {
  readonly endedAt: Date;
  readonly elapsedMs: WritingSessionResult['elapsedMs'];
}

/** The name to show for a selection whose catalogue row the server could not resolve. */
const UNNAMED_SELECTION = 'the practice already there';

/** The open selection at Green, if the writer has one that is not Journaling itself. */
function displacedName(
  selections: readonly Awaited<ReturnType<typeof userPractices.list>>[number][],
  journalingId: number,
): string | null {
  const open = selections.find(
    (row) => row.end_date === null && row.stage_number === GREEN_STAGE_NUMBER,
  );
  if (open === undefined || open.practice_id === journalingId) return null;
  return open.effective_name ?? open.custom_name ?? UNNAMED_SELECTION;
}

/**
 * Ask what keeping this session as a practice would do, without doing any of it.
 *
 * Three reads, in parallel: the catalogue row to select, the selections it
 * might displace, and how far the writer's programme has opened. All three are
 * needed to compose one honest sentence, and none of them is worth a request
 * until the writer has asked for this.
 *
 * @returns The plan, or ``null`` when the catalogue has no ``Journaling`` row
 *   or any lookup failed — the offer says so rather than guessing.
 */
export async function planKeepAsPractice(): Promise<PracticeOfferPlan | null> {
  try {
    const [catalogue, selections, calendar] = await Promise.all([
      practices.listAll({ stageNumber: GREEN_STAGE_NUMBER }),
      userPractices.list(),
      stages.programCalendar(),
    ]);
    const row = catalogue.find((item) => item.name === JOURNALING_PRACTICE_NAME);
    if (row === undefined) return null;
    return {
      practiceId: row.id,
      displaces: displacedName(selections, row.id),
      // ``current_stage`` is the server's own union of what the calendar has
      // opened and what the record has entered, so it is the same answer the
      // session-logging gate will give — not a second derivation of it.
      waitingAt:
        calendar.current_stage >= GREEN_STAGE_NUMBER
          ? null
          : stageAtIndex(calendar.current_stage - 1),
    };
  } catch {
    return null;
  }
}

/** Log the finished writing against the new selection, reporting whether it landed. */
async function logFinishedWriting(
  userPracticeId: number,
  writing: FinishedWriting,
): Promise<boolean> {
  try {
    await practiceSessions.create(
      manualSessionPayload({
        userPracticeId,
        endedAt: writing.endedAt,
        durationMinutes: writing.elapsedMs / MS_PER_MINUTE,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Select ``Journaling`` at Green and, when Green is open, log the session.
 *
 * The two writes are reported separately because they can disagree: a
 * selection that lands while the session log does not is a practice the writer
 * really does have, and telling them otherwise would send them looking for
 * something that is already there.
 *
 * @param plan - What ``planKeepAsPractice`` found, and the writer agreed to.
 * @param writing - The finished session to record.
 * @returns What was kept, and whether the session went with it.
 */
export async function keepAsPractice(
  plan: PracticeOfferPlan,
  writing: FinishedWriting,
): Promise<KeepPracticeOutcome> {
  let selection;
  try {
    selection = await userPractices.create({
      practice_id: plan.practiceId,
      stage_number: GREEN_STAGE_NUMBER,
    });
  } catch {
    return { kept: false, sessionLogged: false };
  }
  if (plan.waitingAt !== null) return { kept: true, sessionLogged: false };
  return { kept: true, sessionLogged: await logFinishedWriting(selection.id, writing) };
}
