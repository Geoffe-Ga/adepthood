/**
 * The one server-to-store writer for the program anchor (#3097).
 *
 * The server owns ``program_started_at``; every read of the program calendar --
 * the once-per-session reconcile, the PUT's echo, the Map's cold-start seed --
 * lands here, so Course, Journal, Practice, the Map and habit reveal all read
 * one value. Deliberately free of the API client and the stage service so the
 * Map can call it without an import cycle.
 */
import type { ProgramCalendar } from '../../api';
import { useProgramStore } from '../../store/useProgramStore';
import { useStageStore } from '../../store/useStageStore';
import { dayKeyInTZ } from '../../utils/dateUtils';

/** The only cycle whose start date the person may pick (mirrors the backend's ``_FIRST_CYCLE``). */
const FIRST_CYCLE = 1;

/**
 * Mirror a program-calendar response into the client stores.
 *
 * ``tz`` is the account zone the anchor's local midnight is counted in. A caller
 * that has none (the Map's stage seed) passes ``null`` and adopts everything but
 * the day, which the session reconcile and the PUT echo supply.
 */
export function adoptProgramCalendar(calendar: ProgramCalendar, tz: string | null): void {
  const window = calendar.program_start_window ?? null;
  const locked = calendar.cycle_number > FIRST_CYCLE || calendar.program_start_window === null;
  const day =
    tz !== null && calendar.program_started_at !== null
      ? dayKeyInTZ(calendar.program_started_at, tz)
      : null;
  useProgramStore.getState().adoptServerProgramStart({ day, window, locked });
  const stages = useStageStore.getState();
  stages.setCurrentStage(calendar.current_stage);
  stages.setCycleNumber(calendar.cycle_number);
}
