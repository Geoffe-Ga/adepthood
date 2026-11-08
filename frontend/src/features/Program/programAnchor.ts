/**
 * Pick, change and reconcile the program start date (#3097).
 *
 * ``commitProgramStart`` is the one place the client asks the server to move
 * the anchor; ``reconcileProgramAnchor`` is the one place it re-reads it outside
 * the existing calendar reads. Both adopt through ``adoptProgramCalendar``, so
 * the store is only ever written with what the server actually holds.
 */
import { stages } from '../../api';
import { formatApiError } from '../../api/errorMessages';
import { captureAuthScope, isAuthScopeCurrent } from '../../api/sessionToken';
import { stageService } from '../Map/services/stageService';

import { adoptProgramCalendar } from './adoptProgramCalendar';

/** What became of a pick. A failure always leaves the previous anchor in place. */
export type ProgramStartOutcome =
  { kind: 'saved' } | { kind: 'refused'; message: string } | { kind: 'unsaved'; message: string };

/** Copy for a pick that never reached the server (offline, timeout, 5xx). */
export const PROGRAM_START_NOT_SAVED_COPY =
  "Your start date didn't save. Check your connection and try again; your earlier start date still stands.";

const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/**
 * The server's deliberate refusals: a date outside the window, or a fixed
 * anchor. Read structurally off ``status`` -- the shape ``formatApiError``
 * reads too -- so the check holds for any ``ApiError`` the client raises.
 */
const isRefusal = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return status === HTTP_UNPROCESSABLE || status === HTTP_CONFLICT;
};

const failureOutcome = (err: unknown): ProgramStartOutcome =>
  isRefusal(err)
    ? { kind: 'refused', message: formatApiError(err) }
    : { kind: 'unsaved', message: PROGRAM_START_NOT_SAVED_COPY };

export interface CommitProgramStartOptions {
  /** The account zone the day is counted in. */
  tz: string;
  token?: string;
}

/**
 * Ask the server to start the program on ``day`` (``YYYY-MM-DD``, account zone).
 *
 * Pessimistic: nothing is written until the server agrees, so a refusal or a
 * dropped connection leaves every screen on the date that still stands. On
 * success the echoed calendar is adopted and the Map's stage list is reloaded
 * (best-effort), because its unlock overlay is otherwise loaded once a session.
 */
export async function commitProgramStart(
  day: string,
  { tz, token }: CommitProgramStartOptions,
): Promise<ProgramStartOutcome> {
  const scope = captureAuthScope();
  try {
    const calendar = await stages.setProgramStart(day, token);
    if (!isAuthScopeCurrent(scope)) return { kind: 'saved' };
    adoptProgramCalendar(calendar, tz);
  } catch (err) {
    return failureOutcome(err);
  }
  void stageService.loadStages(token);
  return { kind: 'saved' };
}

/**
 * Re-read the server's anchor once and adopt it.
 *
 * ``GET /stages/program-calendar`` records a visit, so this runs once per
 * signed-in session (``useProgramAnchorSync``), never on every foreground or
 * habits refresh. A failure is swallowed: the cached anchor stands offline.
 */
export async function reconcileProgramAnchor(tz: string, token?: string): Promise<void> {
  const scope = captureAuthScope();
  try {
    const calendar = await stages.programCalendar(token);
    if (!isAuthScopeCurrent(scope)) return;
    adoptProgramCalendar(calendar, tz);
  } catch {
    // Best-effort: the cached (or habit-derived) anchor stays in place.
  }
}
