/**
 * Pure decisions for re-opening an entry whose load failed offline (#2935).
 *
 * The API client short-circuits every GET while the device is known offline, so
 * an entry opened from the shelf without a connection never loads, and the
 * screen keeps its entry-not-loaded gate on (autosave, Finish and the tier and
 * chord controls all stand down). {@link shouldReloadEntryOnReconnect} decides
 * when that load is re-run: once per offline -> online edge, the same edge the
 * save retry of #2930 keys on (see ``shouldRetryOnReconnect`` in
 * ``journalSaveRetry.ts`` and ``useReconnectRetry`` in ``useSaveRetry.ts``).
 *
 * The page is never input-locked while unloaded: the writer can type into it,
 * and nothing persists those words. {@link reconcileUnloadedDraft} decides what
 * the page shows once the stored copy finally arrives, so that neither side is
 * lost: the stored copy always survives whole, and anything typed while the
 * entry was unloaded is carried below it, the way a transcript is appended.
 */
import { appendTranscript } from './appendTranscript';
import { isTierLooser } from './journalSaveRetry';

import type { JournalClassification } from '@/api';

/** Everything the reconnect reload decision reads, as plain values. */
export interface EntryReloadGate {
  /** Connectivity before this change. */
  wasOnline: boolean;
  /** Connectivity now. */
  isOnline: boolean;
  /** The screen was opened on an existing entry (a route entry id). */
  hasEntryId: boolean;
  /** The stored entry has already been applied to the page. */
  loaded: boolean;
  /** The last load attempt failed, so the load-error banner is showing. */
  loadFailed: boolean;
  /** A load of this entry is already outstanding. */
  inFlight: boolean;
}

/** Reload only on the offline -> online edge, only for an existing entry whose
 *  load failed and has not since succeeded, and never on top of a load that is
 *  already running. A load that failed while the device believed it was online
 *  has no such edge and is not retried here. */
export function shouldReloadEntryOnReconnect(gate: EntryReloadGate): boolean {
  const edge = !gate.wasOnline && gate.isOnline;
  const failedEntry = gate.hasEntryId && !gate.loaded && gate.loadFailed;
  return edge && failedEntry && !gate.inFlight;
}

/** A page's title and body. */
export interface PageText {
  title: string;
  body: string;
}

/** What the page shows after a load, and whether any offline typing was kept. */
export interface ReconciledText extends PageText {
  /** True when words typed while unloaded were kept, so they still need saving. */
  carried: boolean;
}

/** The line a carried title and body are joined with inside the carried block. */
const CARRIED_LINE_BREAK = '\n';

function typed(local: string, baseline: string): string {
  return local !== baseline && local.trim() !== '' ? local : '';
}

/**
 * Combine the stored entry with what the writer typed while it was unloaded.
 *
 * ``baseline`` is what the page held when it opened (its pre-fill, usually
 * blank). A field still equal to it, blank, or whitespace-only counts as
 * untouched and shows the stored value. A typed body is appended below the
 * stored body. A typed title fills an empty stored title, is dropped when it
 * matches the stored one, and otherwise leads the carried block on its own line
 * so the stored title is never replaced. The stored copy is never shortened.
 */
export function reconcileUnloadedDraft(
  server: PageText,
  local: PageText,
  baseline: PageText,
): ReconciledText {
  const typedTitle = typed(local.title, baseline.title);
  const typedBody = typed(local.body, baseline.body);
  const adoptTitle = typedTitle !== '' && server.title.trim() === '';
  const leadTitle = typedTitle !== '' && !adoptTitle && typedTitle !== server.title;
  const block = [leadTitle ? typedTitle : '', typedBody]
    .filter((part) => part !== '')
    .join(CARRIED_LINE_BREAK);
  const title = adoptTitle ? typedTitle : server.title;
  const body = appendTranscript(server.body, block);
  return { title, body, carried: title !== server.title || body !== server.body };
}

/**
 * The tier to move the stored entry to before carried words are saved, or null
 * when none is needed. Words typed while the page showed ``typedUnder`` must
 * never land in an entry stored under a looser tier, and a tier only ever
 * escalates (the rule ``isTierLooser`` enforces for the #2930 retry and the
 * #2936 replay reconcile): so a looser stored tier is raised to the one shown,
 * and an equal or stricter one is left exactly as it is.
 */
export function carriedTierEscalation(
  stored: JournalClassification,
  typedUnder: JournalClassification,
): JournalClassification | null {
  return isTierLooser(stored, typedUnder) ? typedUnder : null;
}

/**
 * What this page knows the server has stored as the entry's tier (#2935).
 *
 * ``seq`` is the send order of the tier write that last set it (0 for the tier
 * the entry loaded with, when ``tier`` is null). ``unknownSince`` is set by a
 * failed write newer than that: a failed response does not say what the server
 * committed, so until a still newer write succeeds the tier is unknown.
 */
export interface ConfirmedTierState {
  tier: JournalClassification | null;
  seq: number;
  unknownSince: number | null;
}

/** The state before any tier write: the tier the entry loaded with, known. */
export const LOADED_TIER_STATE: ConfirmedTierState = { tier: null, seq: 0, unknownSince: null };

/** The outcome of one tier write, tagged with its send order. */
export type TierWriteOutcome =
  { seq: number; ok: true; stored: JournalClassification } | { seq: number; ok: false };

/**
 * Fold one tier write's outcome into what is known. Outcomes can arrive out of
 * send order, so a success counts only if it is newer than the last one, and a
 * failure makes the tier unknown only if it is newer than the last success.
 */
export function confirmTierWrite(
  state: ConfirmedTierState,
  outcome: TierWriteOutcome,
): ConfirmedTierState {
  if (outcome.seq <= state.seq) return state;
  if (!outcome.ok) {
    return { ...state, unknownSince: Math.max(state.unknownSince ?? 0, outcome.seq) };
  }
  const stillUnknown = state.unknownSince != null && state.unknownSince > outcome.seq;
  return {
    tier: outcome.stored,
    seq: outcome.seq,
    unknownSince: stillUnknown ? state.unknownSince : null,
  };
}

/** The confirmed tier, ``loaded`` standing in for the load's; null while unknown. */
export function knownTier(
  state: ConfirmedTierState,
  loaded: JournalClassification,
): JournalClassification | null {
  if (state.unknownSince != null) return null;
  return state.tier ?? loaded;
}
