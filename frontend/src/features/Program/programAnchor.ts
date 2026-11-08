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
import {
  clearPendingProgramStart,
  loadPendingProgramStart,
  savePendingProgramStart,
} from '../../storage/pendingProgramStart';
import { stageService } from '../Map/services/stageService';

import { adoptProgramCalendar } from './adoptProgramCalendar';

/** What became of a pick. A failure always leaves the previous anchor in place. */
export type ProgramStartOutcome =
  { kind: 'saved' } | { kind: 'refused'; message: string } | { kind: 'unsaved'; message: string };

/** Copy for a pick that never reached the server (offline, timeout, 5xx). */
export const PROGRAM_START_NOT_SAVED_COPY =
  "Your start date didn't save. Check your connection and try again; your earlier start date still stands.";

/**
 * Copy for a first pick that never reached the server. There is no earlier date
 * to fall back on, so it says the pick is held and will be sent again.
 */
export const PROGRAM_START_PENDING_COPY =
  "Your start date didn't save yet. We'll send it again the next time you open the app online.";

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

/**
 * Bumped whenever a commit is about to write, and again when it adopts its
 * echo. A reconcile read that started before either cannot know about that
 * write, so it is dropped rather than adopted over a newer answer.
 */
let anchorEpoch = 0;

const swallowStorageFailure = (op: Promise<void>): void => {
  op.catch(() => {
    // Best-effort: the held pick is a retry hint, never the anchor itself.
  });
};

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
  anchorEpoch += 1;
  try {
    const calendar = await stages.setProgramStart(day, token);
    if (!isAuthScopeCurrent(scope)) return { kind: 'saved' };
    anchorEpoch += 1;
    adoptProgramCalendar(calendar, tz);
  } catch (err) {
    return failureOutcome(err);
  }
  // The server now holds a deliberate pick; an older held one must not override it.
  swallowStorageFailure(clearPendingProgramStart());
  void stageService.loadStages(token);
  return { kind: 'saved' };
}

/**
 * Hold a first pick that never reached the server, so the next session's
 * reconcile sends it before adopting whatever the server stamped meanwhile.
 */
export async function holdPendingProgramStart(day: string): Promise<void> {
  try {
    await savePendingProgramStart(day);
  } catch {
    // Best-effort: without the hint the server's answer is adopted as before.
  }
}

/**
 * What became of a held pick at the start of a reconcile: ``none`` held (read
 * the server), ``sent`` (its echo is already the server's answer), ``dropped``
 * (refused for good; read the server), or ``held`` (still unsendable; the
 * device keeps the pick and the server's stamp is not adopted).
 */
type PendingPickResult = 'none' | 'sent' | 'dropped' | 'held';

async function sendPendingPick(tz: string, token?: string): Promise<PendingPickResult> {
  const pending = await loadPendingProgramStart();
  if (pending === null) return 'none';
  const outcome = await commitProgramStart(pending, { tz, token });
  if (outcome.kind === 'saved') return 'sent';
  if (outcome.kind === 'unsaved') return 'held';
  swallowStorageFailure(clearPendingProgramStart());
  return 'dropped';
}

/**
 * Re-read the server's anchor once and adopt it.
 *
 * ``GET /stages/program-calendar`` records a visit, so this runs once per
 * signed-in session (``useProgramAnchorSync``), never on every foreground or
 * habits refresh. A failure is swallowed: the cached anchor stands offline.
 *
 * A first pick held from an offline save is sent first: the server stamped a
 * default once the habits reached it, and adopting that stamp would silently
 * replace the day the person chose. A read that a commit overtook is dropped.
 */
export async function reconcileProgramAnchor(tz: string, token?: string): Promise<void> {
  const scope = captureAuthScope();
  const pending = await sendPendingPick(tz, token);
  if (pending === 'sent' || pending === 'held' || !isAuthScopeCurrent(scope)) return;
  const epoch = anchorEpoch;
  try {
    const calendar = await stages.programCalendar(token);
    if (!isAuthScopeCurrent(scope) || epoch !== anchorEpoch) return;
    adoptProgramCalendar(calendar, tz);
  } catch {
    // Best-effort: the cached (or habit-derived) anchor stays in place.
  }
}
