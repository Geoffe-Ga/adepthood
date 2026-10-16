import type { CourseSession } from './courseSession';
import { START_HERE } from './stageDisplay';

import { stages, uiFlags, type CourseProgress, type Stage } from '@/api';
import { programStage } from '@/store/useProgramStore';

/**
 * Explicit navigation wins; an unknown reading state cannot establish completion.
 *
 * A failed Start Here read leaves progress unknown, so entry opens Start Here,
 * which reports the failure with a retry, rather than failing the whole Course
 * and hiding chapter navigation that loaded fine (#3344).
 */
export async function loadInitialReadingStage(
  available: Stage[],
  anchor: Date | null,
  progress: CourseProgress | null,
  explicit: number | null,
  session: CourseSession,
): Promise<number> {
  const assertCurrent = () => {
    if (!session.current()) throw new Error('Course session changed');
  };
  assertCurrent();
  if (explicit !== null) return explicit;
  if (!progress || progress.read_items < progress.total_items) return START_HERE;
  const { course_last_stage: saved } = await uiFlags.get(session.token);
  assertCurrent();
  const previous = available.find((stage) => stage.stage_number === saved && stage.is_unlocked);
  const selected = previous?.stage_number ?? programStage(anchor);
  if (selected !== null && selected !== undefined) return selected;
  const calendar = await stages.programCalendar(session.token);
  assertCurrent();
  return calendar.current_stage;
}
