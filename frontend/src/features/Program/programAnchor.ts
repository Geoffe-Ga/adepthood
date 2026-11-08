/**
 * Pick, change and reconcile the program start date (#3097).
 *
 * ``commitProgramStart`` is the one place the client asks the server to move
 * the anchor; ``reconcileProgramAnchor`` is the one place it re-reads it outside
 * the existing calendar reads. Both adopt through ``adoptProgramCalendar``, so
 * the store is only ever written with what the server actually holds.
 */
import { stages, type ProgramCalendar } from '../../api';
import { formatApiError } from '../../api/errorMessages';
import { captureAuthScope, isAuthScopeCurrent } from '../../api/sessionToken';
import {
  clearPendingProgramStart,
  loadPendingProgramStart,
  savePendingProgramStart,
  type HeldProgramStart,
} from '../../storage/pendingProgramStart';
import { dayKeyInTZ } from '../../utils/dateUtils';
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
 * Bumped when a commit adopts its echo. A reconcile read that started before
 * then cannot know about that write, so it is dropped rather than adopted over
 * a newer answer. A commit that wrote nothing -- refused, or never answered --
 * leaves it alone, so the session's one reconcile read still lands (#3097
 * re-review); the echo, when it comes, is adopted after that read either way.
 */
let anchorEpoch = 0;

/** How far before an anchor to look for the day before it: one millisecond. */
const JUST_BEFORE_MS = 1;

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
 * reconcile can send it again -- for the account named in ``held`` only.
 */
export async function holdPendingProgramStart(held: HeldProgramStart): Promise<void> {
  try {
    await savePendingProgramStart(held);
  } catch {
    // Best-effort: without the hint the server's answer is adopted as before.
  }
}

/**
 * The held pick of the account signed in now. Another account's is let go of:
 * the key is device-wide, and one account's date must never reach another's
 * server (#3097 re-review).
 */
async function loadOwnHeldPick(owner: number | null): Promise<HeldProgramStart | null> {
  const held = await loadPendingProgramStart();
  if (held === null || held.owner === owner) return held;
  swallowStorageFailure(clearPendingProgramStart());
  return null;
}

/**
 * Whether ``at`` is the start of a day in ``tz``. A deliberate pick is stored
 * as local midnight in the account zone; the server's own default stamp is the
 * moment its row was made, which nobody chose.
 */
const isStartOfDay = (at: string, tz: string): boolean => {
  const instant = new Date(at);
  return dayKeyInTZ(new Date(instant.getTime() - JUST_BEFORE_MS), tz) !== dayKeyInTZ(instant, tz);
};

/**
 * Whether replaying ``held`` can overwrite nothing chosen since it was held:
 * the server has no anchor yet, still holds the day it held then, or holds
 * only its own default stamp. Anything else is a date someone picked
 * meanwhile -- on another device, say -- and it wins (#3097 re-review).
 */
const mayReplay = (held: HeldProgramStart, calendar: ProgramCalendar, tz: string): boolean => {
  const at = calendar.program_started_at;
  if (at === null) return true;
  return dayKeyInTZ(at, tz) === held.priorServerDay || !isStartOfDay(at, tz);
};

/**
 * Send a held pick the server read in ``calendar`` still allows. ``true`` when
 * nothing further is to be adopted: the echo already was, or the pick is still
 * unsendable and the device keeps counting from it. A refused pick, or one the
 * server has moved past, is let go of and the server's read is adopted.
 */
async function settleHeldPick(
  held: HeldProgramStart,
  calendar: ProgramCalendar,
  tz: string,
  token?: string,
): Promise<boolean> {
  if (mayReplay(held, calendar, tz)) {
    const outcome = await commitProgramStart(held.day, { tz, token });
    if (outcome.kind !== 'refused') return true;
  }
  swallowStorageFailure(clearPendingProgramStart());
  return false;
}

/**
 * Re-read the server's anchor once and adopt it.
 *
 * ``GET /stages/program-calendar`` records a visit, so this runs once per
 * signed-in session (``useProgramAnchorSync``), never on every foreground or
 * habits refresh. A failure is swallowed: the cached anchor stands offline.
 *
 * A first pick held from an offline save -- by the account signed in now -- is
 * sent before the read is adopted, unless the read shows a date chosen since:
 * the server stamped a default once the habits reached it, and adopting that
 * stamp would silently replace the day the person chose. A read that a commit
 * overtook is dropped.
 */
export async function reconcileProgramAnchor(tz: string, token?: string): Promise<void> {
  const scope = captureAuthScope();
  const held = await loadOwnHeldPick(scope.owner);
  if (!isAuthScopeCurrent(scope)) return;
  const epoch = anchorEpoch;
  let calendar: ProgramCalendar;
  try {
    calendar = await stages.programCalendar(token);
  } catch {
    // Best-effort: the cached (or held, or habit-derived) anchor stays in place.
    return;
  }
  if (!isAuthScopeCurrent(scope) || epoch !== anchorEpoch) return;
  if (held !== null && (await settleHeldPick(held, calendar, tz, token))) return;
  if (!isAuthScopeCurrent(scope) || epoch !== anchorEpoch) return;
  adoptProgramCalendar(calendar, tz);
}
