/**
 * How the offline check-in replay judges a failed POST (#2473).
 *
 * Pure: no clock reads, no storage, no network. ``habitManager`` supplies
 * ``nowMs`` and the persisted head record, and acts on the verdicts here, so
 * every boundary of the give-up policy is testable as a plain function.
 *
 * The policy has three outcomes for a failed head entry:
 *
 * - **permanent** — the server said, in a way that can never change, that this
 *   check-in will not post. Dropped on the first failure, as before.
 * - **counted** — the server answered with a status nobody classified. Retried,
 *   but each answer counts, and an entry that has kept failing for long enough
 *   is given up on so it cannot wedge every check-in queued behind it.
 * - **uncounted** — there was no answer (offline, timeout) or the answer is an
 *   availability or auth signal. Retried forever and never counted, because a
 *   long offline spell or a long outage is not evidence the check-in is bad.
 */
import { ApiError, ApiValidationError } from '../../../api';
import type { ReplayHeadState } from '../../../storage/checkInReplayState';
import type { PendingCheckIn } from '../../../storage/habitStorage';
import { MS_PER_DAY } from '../../../utils/dateUtils';

/**
 * Statuses that mean this queued check-in will never post, however many
 * times we try it. Deliberately a closed allowlist: an unrecognised status
 * falls through to "transient", because mis-reading a transient failure as
 * permanent destroys a check-in the user actually made, while the reverse
 * only costs one retry.
 *
 * NOT the complement of ``TRANSIENT_STATUSES`` in ``api/index.ts``, and the
 * two must not be unified. That set governs an in-flight retry milliseconds
 * apart, where re-sending an expired token is pointless, so it excludes 401.
 * This queue spans app launches and ``AuthContext`` re-hydrates the token at
 * launch, so a 401 here means "not signed in right now", never "this
 * check-in is invalid" — dropping on it would wipe the queue of exactly the
 * user who has one.
 */
export const PERMANENT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 422]);

/**
 * Statuses that are a real server answer but say nothing about the check-in
 * itself: not signed in (401), the request or the server ran out of time (408,
 * 504), slow down (429), or the server is unreachable behind its proxy (502,
 * 503). These never count toward giving up, so an outage that outlasts the age
 * floor cannot cost the user a check-in. Narrower on purpose than "every
 * status that is not permanent": a status earns a count only by being one
 * nobody recognised.
 */
export const UNCOUNTED_REJECTION_STATUSES: ReadonlySet<number> = new Set([
  401, 408, 429, 502, 503, 504,
]);

/**
 * The lowest real HTTP status. The client reports "no response at all" as
 * ``ApiError(0)``, and anything below this floor is that, not a server answer.
 */
export const MIN_HTTP_STATUS = 100;

/**
 * Counted rejections the head entry must accumulate before it can be given
 * up on. Replay runs on every ``loadHabits``, which fires many times in one
 * session, so this count is NOT the wall-clock bound — ``MIN_POISON_AGE_MS``
 * is. The count guards the other direction: a device clock jumped forward
 * cannot make a single rejection look old enough to drop.
 */
export const MAX_CHECK_IN_REPLAY_ATTEMPTS = 5;

/**
 * How long, from its first counted rejection, a head entry must keep being
 * rejected before it can be given up on. This is the real bound on how long a
 * poison entry can wedge the queue. A week, rather than days, because a
 * deterministic-looking 500 that is really a long outage would otherwise cost
 * the user real check-ins; erring long only delays the entries behind it.
 */
export const MIN_POISON_AGE_MS = 7 * MS_PER_DAY;

/** What one failed replay POST means for the entry that sent it. */
export type ReplayFailure =
  | { kind: 'permanent'; status: number }
  | { kind: 'counted'; status: number }
  | { kind: 'uncounted' };

/**
 * Classify a replay failure. Order matters: permanence is checked first so a
 * 404 is always a plain rejection whatever the retry record says, and the
 * uncounted signals before the counted catch-all.
 */
export const classifyReplayFailure = (err: unknown): ReplayFailure => {
  // ApiValidationError does not extend ApiError and carries the response's own
  // status, which can be a 2xx. It is raised only when a received body failed
  // its Zod schema — a deterministic contract defect, so a retry receives the
  // same shape and fails identically, forever. Retrying is harmful for a
  // signed-unit entry: each explicit replay is a fresh delta.
  if (err instanceof ApiValidationError) return { kind: 'permanent', status: err.status };
  if (!(err instanceof ApiError)) return { kind: 'uncounted' };
  const { status } = err;
  if (PERMANENT_REJECTION_STATUSES.has(status)) return { kind: 'permanent', status };
  if (status < MIN_HTTP_STATUS || UNCOUNTED_REJECTION_STATUSES.has(status)) {
    return { kind: 'uncounted' };
  }
  return { kind: 'counted', status };
};

/**
 * A stable name for one queued check-in, so the retry record can tell whether
 * it still describes the current head. ``operation_id`` is unique when
 * present; a legacy entry without one is named by everything it carries.
 */
export const checkInIdentity = (checkIn: PendingCheckIn): string =>
  checkIn.operation_id ??
  [
    checkIn.goal_id,
    checkIn.timestamp,
    checkIn.completed_on ?? '',
    checkIn.did_complete,
    checkIn.completed_units ?? '',
  ].join('|');

/**
 * The retry record after one more counted rejection of ``checkIn``. A record
 * about some other entry is stale — that entry posted or was dropped — so the
 * count restarts; otherwise it grows by one and keeps its first-failure stamp.
 */
export const nextHeadState = (
  prev: ReplayHeadState | null,
  checkIn: PendingCheckIn,
  status: number,
  nowMs: number,
): ReplayHeadState => {
  const identity = checkInIdentity(checkIn);
  if (prev?.identity !== identity) {
    return {
      identity,
      attempts: 1,
      first_rejected_at: new Date(nowMs).toISOString(),
      last_status: status,
    };
  }
  return { ...prev, attempts: prev.attempts + 1, last_status: status };
};

/**
 * Whether the head has been rejected often enough AND for long enough to give
 * up on. Both must hold. An unreadable first-failure stamp never qualifies: a
 * corrupt record must cost a retry, never a check-in.
 */
export const hasExhaustedRetries = (state: ReplayHeadState, nowMs: number): boolean => {
  const firstRejectedMs = Date.parse(state.first_rejected_at);
  if (Number.isNaN(firstRejectedMs)) return false;
  return (
    state.attempts >= MAX_CHECK_IN_REPLAY_ATTEMPTS && nowMs - firstRejectedMs >= MIN_POISON_AGE_MS
  );
};
