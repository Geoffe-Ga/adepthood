/**
 * ``JournalEntryScreen`` — the long-form page the user writes in.
 *
 * Warm editorial layout: an optional serif title and a large growing serif body
 * on a paper ground, with a reserved right-hand margin column that the
 * marginalia UI (``MarginStream``) fills inline. The page autosaves as a draft
 * on idle — there is no send button and no chat UI.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BookOpen, Camera, KeyRound, RefreshCw, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { appendTranscript } from './appendTranscript';
import AspectChordControl, { EMPTY_CHORD, type AspectChordValue } from './AspectChordControl';
import CareSupportNote from './CareSupportNote';
import CompletionSuggestionNote from './CompletionSuggestionNote';
import ContractionReflectionNote from './ContractionReflectionNote';
import type { CorpusDestination } from './corpusDestination';
import CorpusInvitationNote from './CorpusInvitationNote';
import { claimCreateAttempt, type CreateKey, type CreateKeyRef } from './createKey';
import EditConfirmDialog from './EditConfirmDialog';
import { FocusScrollProvider, useFocusScrollHost, type FocusScrollHost } from './focusSpanScroll';
import FromYourCreekPanel from './FromYourCreekPanel';
import GetResonanceButton, {
  shouldShowResonance,
  type ResonanceButtonLayout,
} from './GetResonanceButton';
import HeldWordsLeaveDialog from './HeldWordsLeaveDialog';
import HighlightedBody from './HighlightedBody';
import type { FocusSpan } from './highlightSegments';
import { JournalScreenDrawer } from './JournalDrawer';
import styles from './JournalEntry.styles';
import {
  LOADED_TIER_STATE,
  carriedTierEscalation,
  confirmTierWrite,
  knownTier,
  reconcileUnloadedDraft,
  type TierWriteOutcome,
} from './journalReconnectLoad';
import { isTierLooser, type RetryFailure, type SaveState } from './journalSaveRetry';
import LiveMarkdownBody, { type LiveMarkdownBodyProps } from './LiveMarkdownBody';
import MarginNote from './MarginNote';
import PrivacyTierControl, { DEFAULT_TIER, tierLabel } from './PrivacyTierControl';
import { PROMOTED_NOTICE_COPY } from './promoteExplainerCopy';
import PromoteExplainerDialog from './PromoteExplainerDialog';
import QuoteInclusionHint from './QuoteInclusionHint';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import { readingScrollStyle } from './readingSurfaceStyles';
import { formatQuotePrefill } from './reflectionCopy';
import ReflectionSourcesPanel from './ReflectionSourcesPanel';
import { useRefreshAfterEdit } from './refreshAfterEdit';
import { isStoredAs, replayReconcilePatch, type SentPage } from './replayReconcile';
import ResonanceEssayModal from './ResonanceEssayModal';
import ResonanceExplainerDialog from './ResonanceExplainerDialog';
import ResonanceRefillDialog from './ResonanceRefillDialog';
import { describeSuggestionFacts } from './suggestionFacts';
import { useEntryLoad } from './useEntryLoad';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useLinkedHabitCheckOff } from './useLinkedHabitCheckOff';
import { usePromotedQuoteHandoff } from './usePromotedQuoteHandoff';
import { usePromoteExplainer, type PromoteExplainerGate } from './usePromoteExplainer';
import { usePromotions } from './usePromotions';
import { useQuickLaunchedSession } from './useQuickLaunchedSession';
import { useReflectionMode } from './useReflectionMode';
import { useResonance } from './useResonance';
import { useResonanceExplainer } from './useResonanceExplainer';
import {
  useReconnectRetry,
  useSaveLedger,
  useSaveRetry,
  type LedgerPorts,
  type SaveReporter,
  type SaveRetry,
} from './useSaveRetry';
import { countWords, wordCountLabel } from './wordCount';
import type { WritingSessionResult } from './writingSession';
import WritingSessionOffer from './WritingSessionOffer';
import WritingSessionSurface from './WritingSessionSurface';

import { journal, prompts, reflections } from '@/api';
import type {
  CheckInResult,
  CompletionSuggestion,
  EntryStatus,
  JournalClassification,
  JournalEntryUpdate,
  JournalMessage,
  Marginalia,
  PromotedQuote,
  ReflectionLevel,
} from '@/api';
import { Button } from '@/components/Button';
import {
  NAV_ICON_SIZE,
  NAV_ICON_STROKE,
  useScreenDrawer,
  type ScreenDrawerState,
} from '@/components/drawer';
import { useAuth } from '@/context/AuthContext';
import {
  accent,
  colors,
  editorialType,
  spacing,
  writingField,
  writingFieldFocus,
} from '@/design/tokens';
import { useEntrance } from '@/hooks/useEntrance';
import { useIdle } from '@/hooks/useIdle';
import { useRestoreFocusOnClose } from '@/hooks/useRestoreFocusOnClose';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useCapturedTranscriptStore } from '@/store/useCapturedTranscriptStore';
import { selectGoalUnitById, useHabitStore } from '@/store/useHabitStore';
import { announceOnIos } from '@/utils/announceOnIos';
import { useDayKey } from '@/utils/dayRollover';

/** Default idle delay before an edit is persisted. */
const AUTOSAVE_DELAY_MS = 1500;

/** Below this width the margin column stacks under the writing column. */
const NARROW_BREAKPOINT = 600;

/**
 * The fixed margin first appears at 600px, but it initially leaves the writing
 * rail too narrow for the Sources label. Keep Sources icon-only through that
 * transition; its accessible name remains complete.
 */
const COMPACT_WRITING_CONTROLS_BREAKPOINT = NARROW_BREAKPOINT + 120;

/** The photograph affordance's name, offered while writing — including to a Course
 *  reflection, which is an ordinary journal page opened with a title. */
const PHOTOGRAPH_PAGE_HINT = 'Photograph a page or screenshot and add its text to this entry';

/** Body-field placeholder for a free-write with no prompt to echo. */
const DEFAULT_BODY_PLACEHOLDER = 'Begin writing…';

/** One visual title line, including the field's vertical paper padding. */
const TITLE_MIN_HEIGHT = editorialType.title.lineHeight + spacing(2);

/** Keep title state single-line regardless of whether text arrived by paste, route, or API. */
function singleLineTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ');
}

/** Fallback reason shown when resonance is gated off for an intimate entry. */
const INTIMATE_RESONANCE_REASON = 'Intimate entries are kept private — resonance is paused.';

/**
 * Shown when an existing entry fails to load. It also promises the entry is
 * untouched — so a failed load must gate autosave off (see ``useDebouncedSave``)
 * or that reassurance becomes a lie.
 */
const LOAD_ERROR_MESSAGE =
  "We couldn't open this entry. Check your connection and try again — your existing writing is safe.";

/**
 * Shown when the atomic Finish write fails. The Finish write is the only path
 * that flips status, so on failure the entry stays a draft: this reassures the
 * writing is untouched (still in local state, autosave keeps retrying) and asks
 * for a simple retry.
 */
const FINISH_ERROR_MESSAGE =
  "We couldn't finish this entry. Check your connection and tap Finish again — your writing is safe here and still saving.";

export type JournalEntryScreenProps = NativeStackScreenProps<RootStackParamList, 'JournalEntry'> & {
  /** Overridable for tests; defaults to {@link AUTOSAVE_DELAY_MS}. */
  autosaveDelayMs?: number;
};

/** The "Saved" confirmation, shared by the edit-mode autosave hint and the
 *  read-mode photograph-capture handoff so both read identically. */
const SAVED_HINT = 'Saved';
/** A blank hint line that reserves the row's height without showing any text. */
const BLANK_HINT = ' ';

/**
 * Said when the week already holds its one prompt response. Distinct from the
 * generic save error because retrying cannot clear it — the server keeps one
 * response per week — so the hint names the condition and the way out instead
 * of telling the writer to keep going.
 */
const WEEK_TAKEN_HINT = 'Already answered this week — copy this into a new page to keep it.';
const VAULT_WITHDRAWAL_PENDING_HINT =
  'Intimate here. Creek has not confirmed removal yet — bring your vault online, then choose Intimate again.';

/**
 * The state the save hint should show while a quote is being folded in.
 *
 * A fold-in is one act made of two writes — the entry body, then the mark that
 * retires the quote from the pending set — and only the first drives
 * ``saveState``. Reporting its "saved" while the second is still on the wire
 * would announce a finished save that has not finished, and would be followed
 * (on a failure) by a hint contradicting the word already shown. So the whole
 * act reads as saving, and the hint settles once for the pair.
 *
 * Overriding a real ``error`` or ``typing`` that overlaps the window is
 * deliberate, not an oversight: a write IS in flight, so "Saving…" is the true
 * statement, and an error from the draft save is about to be re-decided by the
 * fold-in's own outcome anyway. Threading the underlying state through would
 * surface a retry affordance for a write that is still running.
 */
function hintStateWhileFolding(state: SaveState, foldingIn: boolean): SaveState {
  return foldingIn ? 'saving' : state;
}

/** What the footer says, and offers, while offline words are held (#2935). */
interface HeldFooter {
  label: string;
  /** Retry re-sends the tier the words were typed under. */
  canRetry: boolean;
}

/** What the writing footer's Retry does, and the held state it shows. */
interface SaveFooterActions {
  retry: () => Promise<void>;
  held: HeldFooter | null;
}

/** The hint while held words wait on no particular tier (e.g. mid-escalation). */
const HELD_HINT = 'Not saved yet';

/** The hint while held words wait on the entry being made ``tier`` or stricter. */
function heldHintCopy(tier: JournalClassification): string {
  return `${HELD_HINT} — waiting until this entry is ${tierLabel(tier)} or more private`;
}

/** The footer's held state, or null when nothing is held. */
function heldFooterFor(
  autosave: Pick<AutosaveApi, 'carryHeld' | 'carryWaitingTier' | 'carryRetryReady'>,
): HeldFooter | null {
  if (!autosave.carryHeld) return null;
  const tier = autosave.carryWaitingTier;
  return {
    label: tier == null ? HELD_HINT : heldHintCopy(tier),
    canRetry: autosave.carryRetryReady,
  };
}

function savedHintLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'saved') return SAVED_HINT;
  if (state === 'weekTaken') return WEEK_TAKEN_HINT;
  if (state === 'vaultWithdrawalPending') return VAULT_WITHDRAWAL_PENDING_HINT;
  if (state === 'error') return "Couldn't save — keep writing, we'll retry";
  return BLANK_HINT;
}

/**
 * What context this entry is being written into. A ``weekNumber`` makes it a
 * weekly-prompt response (recorded via the prompt endpoint, which creates the
 * journal entry server-side — so we never also ``journal.create``); the practice
 * ids link a session/stage reflection to its source.
 */
interface SaveContext {
  weekNumber?: number;
  /** Which of the stage's prompts the response answers, 1-based; omitted means
   *  the prompt the week itself draws. */
  promptOrdinal?: number;
  practiceSessionId?: number;
  userPracticeId?: number;
  /** Reflection scope this page closes (7th-day reflection compose mode). */
  reflectionLevel?: ReflectionLevel;
  /** The scope key the reflection covers (e.g. ``c1:w14``); pairs with ``reflectionLevel``. */
  reflectionScopeKey?: string;
}

/** HTTP status the backend returns when a reflection already exists for the scope. */
const REFLECTION_CONFLICT_STATUS = 409;
/** True for a create rejection that means "this reflection already exists". */
function isCreateConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === REFLECTION_CONFLICT_STATUS
  );
}

/** True only for the stable failure emitted after local privacy commits first. */
function isVaultWithdrawalPending(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { detail?: unknown }).detail === 'vault_withdrawal_pending'
  );
}

interface WriteEntryRefs {
  entryIdRef: React.MutableRefObject<number | null>;
  respondedRef: React.MutableRefObject<boolean>;
  /** Latest chosen privacy tier; carried on the first ``journal.create``. */
  classificationRef: React.MutableRefObject<JournalClassification>;
  /** Latest chosen Aspect chord; carried on the first ``journal.create``. */
  chordRef: React.MutableRefObject<AspectChordValue>;
  /**
   * The page's one create key (#2936): every attempt to create this page, or to
   * answer its weekly prompt, is sent under it until the server has the page.
   */
  createKeyRef: CreateKeyRef<SentPage>;
}

/** What this page would send on a create attempt made now. */
function sentPage(refs: WriteEntryRefs, title: string, body: string): SentPage {
  return {
    message: body,
    title: titleOrNull(title),
    classification: refs.classificationRef.current,
    chord: refs.chordRef.current,
  };
}

/**
 * Create the entry with its full body + tags in one call, returning the new
 * server id. Only attaches context keys when present, so a plain entry's payload
 * stays lean rather than carrying explicit nulls. ``classification`` always rides
 * along so the entry's privacy tier is set at birth (defaults to personal).
 *
 * Every attempt goes under the page's one create key, so a retry of a create
 * whose answer was lost is answered with the entry it already wrote. A resent
 * attempt reconciles before it returns, writing back only what changed on this
 * page since the first attempt and never loosening the tier the returned row
 * holds (``replayReconcilePatch``). The caller assigns the id only after that,
 * so a reconcile that fails leaves the page id-less and the next attempt
 * replays and reconciles again rather than PATCHing only the body.
 */
async function createEntry(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<number> {
  const { classificationRef, chordRef } = refs;
  const now = sentPage(refs, title, body);
  const { key, resent, first } = claimCreateAttempt(refs.createKeyRef, now);
  const created = await journal.create(
    {
      message: body,
      title: titleOrNull(title),
      classification: classificationRef.current,
      primary_aspect: chordRef.current.primary,
      secondary_aspect: chordRef.current.secondary,
      ...(ctx.practiceSessionId != null && { practice_session_id: ctx.practiceSessionId }),
      ...(ctx.userPracticeId != null && { user_practice_id: ctx.userPracticeId }),
      ...(ctx.reflectionLevel != null && { tag: 'hierarchical_reflection' as const }),
      ...(ctx.reflectionLevel != null && { reflection_level: ctx.reflectionLevel }),
      ...(ctx.reflectionScopeKey != null && { reflection_scope_key: ctx.reflectionScopeKey }),
    },
    { idempotencyKey: key },
  );
  const reconcile = resent ? replayReconcilePatch(first, now, created) : null;
  if (reconcile != null) await journal.update(created.id, reconcile);
  return created.id;
}

/**
 * Answer the page's weekly prompt, exactly once. Resolves to ``null`` when the
 * text sent is what the week now holds, or to the stored answer when a resent
 * attempt was answered with an EARLIER one (#2936): its first attempt landed,
 * and the words typed since cannot be added to a week that holds its answer.
 *
 * Only words changed here since the first attempt can be missing from a replay,
 * so an unchanged resend is simply saved, whatever the server's sanitizer did
 * to it; a changed one is compared allowing for that sanitizer.
 */
async function respondOnce(
  refs: WriteEntryRefs,
  weekNumber: number,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<string | null> {
  const { key, resent, first } = claimCreateAttempt(refs.createKeyRef, sentPage(refs, title, body));
  const detail = await prompts.respond(weekNumber, body, {
    title: titleOrNull(title),
    ...(ctx.promptOrdinal != null && { promptOrdinal: ctx.promptOrdinal }),
    idempotencyKey: key,
  });
  refs.respondedRef.current = true;
  const drifted = resent && first.message !== body;
  return drifted && !isStoredAs(detail.response, body) ? (detail.response ?? '') : null;
}

/** A blank title collapses to null so an empty title is stored as absent. */
function titleOrNull(title: string): string | null {
  return title.trim() ? title : null;
}

/**
 * Create on first save, then update; a new page's title and body land atomically.
 * Resolves to the body the server holds when that is NOT the body sent (a
 * replayed weekly-prompt answer; see ``respondOnce``), else ``null``.
 */
async function writeEntry(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<string | null> {
  const { entryIdRef, respondedRef } = refs;
  // Weekly-prompt mode: the respond endpoint persists the entry itself, so we
  // submit exactly once and never pair it with journal.create (no double-create).
  if (ctx.weekNumber != null) {
    if (respondedRef.current) return null;
    return respondOnce(refs, ctx.weekNumber, title, body, ctx);
  }
  const trimmedTitle = titleOrNull(title);
  if (entryIdRef.current == null) {
    entryIdRef.current = await createEntry(refs, title, body, ctx);
  } else {
    await journal.update(entryIdRef.current, { message: body, title: trimmedTitle });
  }
  return null;
}

/** What the Finish write left on the server: the entry id and its stored body. */
interface FinishedEntry {
  id: number;
  /**
   * The body exactly as stored. The server sanitizes it (NFC, zero-width marks
   * stripped, edges trimmed), so it can differ from the text that was sent, and
   * every anchor offset promoted from read mode indexes THIS string.
   */
  message: string;
}

/**
 * The single authoritative Finish write: one atomic update that carries the FULL
 * body + title alongside the ``finished`` status flip, so an earlier, shorter
 * autosave can never win. Rejects on failure (never swallows) so the caller keeps
 * the entry a draft and surfaces a retry. Resolves to the finished entry's id
 * and the body the server stored.
 *
 * Weekly-prompt compose has no local id to finish, so the Finish affordance is
 * withheld there and this path handles only plain/practice entries.
 */
async function finishWrite(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<FinishedEntry> {
  const finishTitle = titleOrNull(title);
  const id = refs.entryIdRef.current;
  if (id == null) {
    const created = await createEntry(refs, title, body, ctx);
    refs.entryIdRef.current = created;
    const finished = await journal.update(created, { title: finishTitle, status: 'finished' });
    return { id: created, message: finished.message };
  }
  const finished = await journal.update(id, {
    message: body,
    title: finishTitle,
    status: 'finished',
  });
  return { id, message: finished.message };
}

interface AutosaveApi {
  /** The persisted entry id, including one created without a route transition. */
  entryId: number | null;
  title: string;
  body: string;
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  saveState: SaveState;
  /** The entry's privacy tier; drives the control and the resonance gate. */
  classification: JournalClassification;
  /** The entry's Aspect chord; drives the chord control. */
  chord: AspectChordValue;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  /** Set the privacy tier: updates the control and persists (create/PATCH). */
  onChangeClassification: (_tier: JournalClassification) => void;
  /** Set the Aspect chord: updates the control and persists (create/PATCH). */
  onChangeChord: (_next: AspectChordValue) => void;
  /** Persist the latest text immediately and resolve to the entry id (or null). */
  flush: () => Promise<number | null>;
  /**
   * Persist the latest text and resolve to the entry id ONLY when that text is
   * durable on the server; null when the write failed, even though the entry
   * already has an id. For a caller about to record something ABOUT the saved
   * body -- a quote fold marking the quote included on it (#2885) -- where the
   * id alone would vouch for words the server does not hold.
   */
  flushDurable: () => Promise<number | null>;
  /** Persist only if needed and report durable success independently of an id. */
  flushForExit: () => Promise<boolean>;
  /**
   * Perform the single atomic Finish write (full body + title + ``finished``
   * status) after draining any in-flight autosave, resolving to the entry id.
   * Rejects on failure so the caller keeps the entry a draft and offers a retry.
   */
  finish: () => Promise<number>;
  /** Set when loading an existing entry failed; drives the banner. */
  loadError: string | null;
  /**
   * True until an existing entry's load settles (still in flight or failed), so
   * the tier + chord controls stay inert until we know the entry's real values.
   */
  controlsLocked: boolean;
  /**
   * True once an existing entry's own text has been fetched and applied. Always
   * false for a brand-new entry (there is nothing to fetch) and false while a
   * load is in flight or has failed, so a consumer can tell "this page holds
   * writing that already existed" from "this page is still blank".
   */
  loadedFromServer: boolean;
  /** Saved reflection identity, hydrated when an entry is reopened from the shelf. */
  reflectionLevel?: ReflectionLevel;
  reflectionScopeKey?: string;
  /** What the footer's Retry and the reconnect retry re-send through (#2930). */
  retrySource: RetrySource;
  /** True while words typed during an unloaded load wait to be put back (#2935). */
  carryHeld: boolean;
  /** Put held carried words on the page and save them (#2935). */
  releaseCarry: () => Promise<void>;
  /** The tier held words wait on after a failed escalation (#2935), else null. */
  carryWaitingTier: JournalClassification | null;
  /** Re-send the escalation to the tier held words were typed under (#2935). */
  resendCarryTier: () => Promise<void>;
  /** True when that re-send may be offered: words wait, and no tier write is out. */
  carryRetryReady: boolean;
}

/**
 * The writers a save retry re-sends through, plus the ledger recording what
 * failed. Each lane goes back through its ORDINARY writer, so single-flight,
 * the generation gate and revert-on-failure all still hold on a retry.
 */
interface RetrySource {
  ledger: LedgerPorts;
  /** The tier the persister currently holds (what the control shows once settled). */
  displayedTier: () => JournalClassification;
  /**
   * Re-run the body writer on the text on screen NOW (not the text that failed);
   * the writer itself settles the body lane.
   */
  retryBody: () => Promise<unknown>;
  applyClassification: (_tier: JournalClassification) => Promise<void>;
  applyChord: (_chord: AspectChordValue) => Promise<void>;
  /** True while a body or Finish write holds the single-flight slot. */
  isWriteInFlight: () => boolean;
}

/** Clear a pending timeout on unmount, and return a way to cancel it sooner
 *  (e.g. a debounce made stale by a load, #2935). */
function useTimerCleanup(timerRef: TimerRef): () => void {
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [timerRef],
  );
  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [timerRef]);
}

/** A tier/chord PATCH's result; null when nothing was sent or a later change superseded it. */
type PersistState = 'saved' | 'failed' | 'vaultWithdrawalPending' | null;

interface PersistResult<T> {
  revertTo: T | null;
  state: PersistState;
}

interface RefPersist<T> {
  /** The optimistic ref holding the latest value; the create writer rides it. */
  ref: React.MutableRefObject<T>;
  /**
   * Record the value for the next create and PATCH it when the entry exists.
   * Resolves to the value the UI should revert to when a PATCH fails and no
   * later change has superseded it, else null.
   */
  change: (_value: T) => Promise<PersistResult<T>>;
  /**
   * Seed the last-persisted value from a loaded entry so a failed re-tag reverts
   * to the entry's real value rather than the module default.
   */
  seed: (_value: T) => void;
}

/**
 * Owns the latest value behind a control that persists optimistically: the ref
 * rides the first ``journal.create``, and on an existing entry a change is
 * PATCHed immediately (via ``toPatch``) so re-tagging never waits on (or is lost
 * to) the body-save debounce. A failed PATCH reverts to the prior value so the
 * control shows the truth, unless a rapid later change has already superseded
 * it. Assumes one PATCH in flight at a time; ``previous`` is the optimistic ref,
 * not the last-persisted value. Shared by the privacy-tier and Aspect-chord
 * controls; ``toPatch`` must be referentially stable to keep ``change`` stable.
 * The tier path guarantees that assumption with a write queue (#2935) and
 * passes ``report``, which hears each sent write's outcome, numbered in send
 * order; the chord path passes neither and is unchanged.
 */
function useRefPersist<T>(
  entryIdRef: React.MutableRefObject<number | null>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
  initial: T,
  toPatch: (_value: T) => JournalEntryUpdate,
  report?: (_outcome: PersistOutcome<T>) => void,
): RefPersist<T> {
  const ref = useRef<T>(initial);
  const seqRef = useRef(0);
  const change = useCallback(
    async (value: T): Promise<PersistResult<T>> => {
      // Never PATCH until the entry's load settles (still in flight or failed) —
      // the ref is stale and a write here could overwrite the stored (unseen) value.
      if (entryUnsettledRef.current) return { revertTo: null, state: null };
      const previous = ref.current;
      ref.current = value;
      // Create-time: the ref rides the next journal.create, nothing to PATCH yet.
      if (entryIdRef.current == null) return { revertTo: null, state: null };
      const seq = ++seqRef.current;
      try {
        const stored = await journal.update(entryIdRef.current, toPatch(value));
        // Only a write the server accepted is ever reported as confirmed (#2935).
        report?.({ seq, ok: true, value, stored });
        return { revertTo: null, state: 'saved' };
      } catch (error) {
        return failedWrite({ error, seq, value, previous, ref, report });
      }
    },
    [entryIdRef, entryUnsettledRef, toPatch, report],
  );
  const seed = useCallback((value: T): void => {
    ref.current = value;
  }, []);
  return { ref, change, seed };
}

/** One sent persist write's outcome, numbered in send order (#2935). */
type PersistOutcome<T> =
  { seq: number; ok: true; value: T; stored: JournalMessage | null } | { seq: number; ok: false };

interface FailedWrite<T> {
  error: unknown;
  seq: number;
  value: T;
  previous: T;
  ref: React.MutableRefObject<T>;
  report?: (_outcome: PersistOutcome<T>) => void;
}

/** Settle a rejected persist write: keep, revert, or report pending withdrawal. */
function failedWrite<T>({
  error,
  seq,
  value,
  previous,
  ref,
  report,
}: FailedWrite<T>): PersistResult<T> {
  const withdrawalPending = isVaultWithdrawalPending(error);
  // A failed response does not say what the server committed (#2935), except a
  // pending vault withdrawal: the server commits Intimate before asking Creek.
  report?.(withdrawalPending ? { seq, ok: true, value, stored: null } : { seq, ok: false });
  // A rapid superseding change already owns the ref and the UI — leave both
  // to it rather than reverting to this now-stale value.
  if (ref.current !== value) return { revertTo: null, state: null };
  // Keep that safer truth selected and expose its retry path; reverting to
  // Personal would visually contradict persisted privacy.
  if (withdrawalPending) return { revertTo: null, state: 'vaultWithdrawalPending' };
  ref.current = previous;
  return { revertTo: previous, state: 'failed' };
}

// Module-level so the mappers stay referentially stable across renders, keeping
// each ``useRefPersist`` ``change`` callback's identity stable (as the inlined
// twins were) rather than churning every render.
const classificationToPatch = (tier: JournalClassification): JournalEntryUpdate => ({
  classification: tier,
});
const chordToPatch = (chord: AspectChordValue): JournalEntryUpdate => ({
  primary_aspect: chord.primary,
  secondary_aspect: chord.secondary,
});

type TimerRef = React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
/** Whether the requested draft write reached durable storage. */
type RunSave = (_title: string, _body: string, _generation: number) => Promise<boolean>;

interface DraftText {
  title: string;
  body: string;
}

interface FlushResult {
  durable: boolean;
  entryId: number | null;
}

function sameDraft(left: DraftText | null, title: string, body: string): boolean {
  return left?.title === title && left.body === body;
}

interface SaveTimer {
  save: (_title: string, _body: string) => void;
  flush: (_title: string, _body: string) => Promise<FlushResult>;
}

/** Debounce (``save``) + immediate (``flush``) wrappers around the async writer. */
function useSaveTimer(
  run: RunSave,
  timerRef: TimerRef,
  entryIdRef: React.MutableRefObject<number | null>,
  generationRef: React.MutableRefObject<number>,
  delayMs: number,
  setTyping: () => void,
): SaveTimer {
  const save = useCallback(
    (title: string, body: string): void => {
      const generation = ++generationRef.current;
      setTyping();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void run(title, body, generation);
      }, delayMs);
    },
    [run, delayMs, timerRef, generationRef, setTyping],
  );
  // Cancel any pending debounce and persist now. Durable success is distinct
  // from an id because the weekly-prompt endpoint saves without returning one.
  const flush = useCallback(
    async (title: string, body: string): Promise<FlushResult> => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!body.trim()) return { durable: true, entryId: entryIdRef.current };
      const durable = await run(title, body, generationRef.current);
      return { durable, entryId: entryIdRef.current };
    },
    [run, timerRef, entryIdRef, generationRef],
  );
  return { save, flush };
}

/**
 * Wrap a revert-on-failure persister so its outcome lands in its OWN retry
 * lane: a failure records the attempted value for the footer's Retry, and a
 * success clears only that lane (a body or Finish failure stays owed). Used
 * identically by the privacy-tier and chord controls; ``toFailure`` must be
 * referentially stable.
 */
function useLanePersist<T>(
  change: (_value: T) => Promise<PersistResult<T>>,
  reporter: SaveReporter,
  toFailure: (_value: T) => RetryFailure,
): (_value: T) => Promise<T | null> {
  return useCallback(
    async (value: T): Promise<T | null> => {
      const { revertTo, state } = await change(value);
      const failure = toFailure(value);
      if (state === 'failed') {
        reporter.fail(failure);
        reporter.publish('idle');
      } else if (state != null) {
        reporter.succeed(failure.lane);
        reporter.publish(state);
      }
      return revertTo;
    },
    [change, reporter, toFailure],
  );
}

const classificationFailure = (tier: JournalClassification): RetryFailure => ({
  lane: 'classification',
  value: tier,
});
const chordFailure = (chord: AspectChordValue): RetryFailure => ({ lane: 'chord', value: chord });

interface WriteOutcome {
  durable: boolean;
  state: 'saved' | 'failed' | 'weekTaken';
  /** The body the server holds when it is not the body sent (#2936). */
  durableBody?: string;
}

/** Persist once; report its terminal state without publishing a stale result. */
function trackedWrite(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
  onConflict: (() => void) | undefined,
): Promise<WriteOutcome> {
  return (async () => {
    try {
      const heldAnswer = await writeEntry(refs, title, body, ctx);
      // A replayed answer holding earlier words: those are what is durable, and
      // the week's honest state is "already answered", not "saved".
      if (heldAnswer != null) return { durable: true, state: 'weekTaken', durableBody: heldAnswer };
      return { durable: true, state: 'saved' };
    } catch (error) {
      // Surface a distinct error state so the hint isn't mistaken for "untouched".
      // A 409 on the weekly-prompt path is not retryable — the week already holds
      // its one response — so it gets its own state rather than the retry hint.
      const weekTaken = ctx.weekNumber != null && isCreateConflict(error);
      // Additive: a reflection-scope create can 409 because the reflection
      // already exists. Hand that case to the caller (which routes to the
      // existing entry); every other failure keeps the plain save-error hint.
      // This never rejects, so the single-flight drain loops stay safe.
      if (isCreateConflict(error)) onConflict?.();
      return { durable: false, state: weekTaken ? 'weekTaken' : 'failed' };
    }
  })();
}

/** The refs the single-flight writer reads: the write payload plus its gates. */
type SaveRunnerRefs = WriteEntryRefs & {
  entryUnsettledRef: React.MutableRefObject<boolean>;
  ctxRef: React.MutableRefObject<SaveContext>;
  onSavedRef: React.MutableRefObject<(() => void) | undefined>;
  /** Additively invoked on a reflection-scope create 409 (routes to the existing entry). */
  onConflictRef: React.MutableRefObject<(() => void) | undefined>;
  inFlightRef: React.MutableRefObject<Promise<unknown> | null>;
  generationRef: React.MutableRefObject<number>;
  durableTextRef: React.MutableRefObject<DraftText | null>;
};

/**
 * Record a write's truth, but publish it only if no newer edit superseded it.
 * The body's retry lane is recorded either way: a failure stays owed until a
 * later write of the body lands, even when a newer keystroke hid its hint. A
 * week-taken conflict clears the lane — no retry can land it — and names
 * itself in the hint instead.
 */
function settleTrackedWrite(
  generationRef: React.MutableRefObject<number>,
  durableTextRef: React.MutableRefObject<DraftText | null>,
  onSavedRef: React.MutableRefObject<(() => void) | undefined>,
  title: string,
  body: string,
  generation: number,
  outcome: WriteOutcome,
  reporter: SaveReporter,
): void {
  if (outcome.durable) durableTextRef.current = { title, body: outcome.durableBody ?? body };
  if (outcome.state === 'failed') reporter.fail({ lane: 'body' });
  else reporter.succeed('body');
  if (generationRef.current !== generation) return;
  reporter.publish(outcome.state === 'failed' ? 'idle' : outcome.state);
  if (outcome.durable) onSavedRef.current?.();
}

/** Nothing is owed for the body; always true, for the runner's early returns. */
function settledBody(reporter: SaveReporter): true {
  reporter.succeed('body');
  return true;
}

/** True when ``title``/``body`` already landed; settles the body lane if so. */
function alreadyDurable(
  durableTextRef: React.MutableRefObject<DraftText | null>,
  title: string,
  body: string,
  reporter: SaveReporter,
): boolean {
  return sameDraft(durableTextRef.current, title, body) && settledBody(reporter);
}

function rejectSecondPromptEdit(
  ctx: SaveContext,
  responded: boolean,
  isCurrent: boolean,
  reporter: SaveReporter,
): boolean {
  if (ctx.weekNumber == null || !responded) return false;
  if (isCurrent) reporter.publish('weekTaken');
  return true;
}

/**
 * The write payload's refs, as one stable bundle: the refs never change
 * identity, so neither does this, and both writers share it rather than each
 * re-listing every ref in its dependencies.
 */
function useWriteRefs(refs: WriteEntryRefs): WriteEntryRefs {
  const { entryIdRef, respondedRef, classificationRef, chordRef, createKeyRef } = refs;
  return useMemo(
    () => ({ entryIdRef, respondedRef, classificationRef, chordRef, createKeyRef }),
    [entryIdRef, respondedRef, classificationRef, chordRef, createKeyRef],
  );
}

/**
 * The debounced writer, single-flighted: if a save is already in flight, this
 * awaits it (letting a pending create set ``entryIdRef``) before starting, so two
 * overlapping saves of an id-less entry never each fire ``journal.create``.
 */
function useSaveRunner(refs: SaveRunnerRefs, reporter: SaveReporter): RunSave {
  const writeRefs = useWriteRefs(refs);
  const { respondedRef } = refs;
  const { entryUnsettledRef, ctxRef, onSavedRef, onConflictRef } = refs;
  const { inFlightRef, generationRef, durableTextRef } = refs;
  return useCallback<RunSave>(
    async (title, body, generation) => {
      if (entryUnsettledRef.current) return false;
      if (!body.trim()) return settledBody(reporter); // an empty draft has nothing to lose
      while (inFlightRef.current) await inFlightRef.current;
      if (alreadyDurable(durableTextRef, title, body, reporter)) return true;
      // Never bless a later edit that the create-once prompt endpoint cannot persist.
      const isCurrent = generationRef.current === generation;
      if (rejectSecondPromptEdit(ctxRef.current, respondedRef.current, isCurrent, reporter))
        return false;
      if (isCurrent) reporter.publish('saving');
      const task = trackedWrite(writeRefs, title, body, ctxRef.current, onConflictRef.current);
      inFlightRef.current = task;
      try {
        const outcome = await task;
        settleTrackedWrite(
          generationRef,
          durableTextRef,
          onSavedRef,
          title,
          body,
          generation,
          outcome,
          reporter,
        );
        return outcome.durable;
      } finally {
        if (inFlightRef.current === task) inFlightRef.current = null;
      }
    },
    [
      writeRefs,
      respondedRef,
      entryUnsettledRef,
      ctxRef,
      onSavedRef,
      onConflictRef,
      inFlightRef,
      generationRef,
      durableTextRef,
      reporter,
    ],
  );
}

/** The refs the Finish writer reads: the write payload plus its timers + gates. */
type FinishRunnerRefs = WriteEntryRefs & {
  entryUnsettledRef: React.MutableRefObject<boolean>;
  ctxRef: React.MutableRefObject<SaveContext>;
  inFlightRef: React.MutableRefObject<Promise<unknown> | null>;
  timerRef: TimerRef;
  generationRef: React.MutableRefObject<number>;
  durableTextRef: React.MutableRefObject<DraftText | null>;
};

/** Raised when Finish is pressed before an existing entry's load has settled. */
const UNSETTLED_FINISH_ERROR = 'Cannot finish an entry that has not finished loading.';

type RunFinish = (_title: string, _body: string) => Promise<FinishedEntry>;

/**
 * The Finish action: cancel any pending debounce, drain in-flight autosaves so a
 * shorter one can't land after us, then issue the single atomic Finish write.
 * Tracks the save state and rethrows on failure so the caller keeps the draft.
 * A failure is recorded in the Finish retry lane whatever the generation, so a
 * keystroke during the write cannot lose it; a success also settles the body,
 * whose full text the Finish write carried.
 */
function useFinishWriter(refs: FinishRunnerRefs, reporter: SaveReporter): RunFinish {
  const writeRefs = useWriteRefs(refs);
  const { entryUnsettledRef, ctxRef, inFlightRef, timerRef, generationRef, durableTextRef } = refs;
  return useCallback<RunFinish>(
    async (title, body) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const generation = generationRef.current;
      // The tracked autosave never rejects, so draining it is safe; this ensures a
      // slower, shorter autosave can't overwrite the body after the Finish write.
      while (inFlightRef.current) await inFlightRef.current;
      if (entryUnsettledRef.current) throw new Error(UNSETTLED_FINISH_ERROR);
      reporter.publish('saving');
      const task = finishWrite(writeRefs, title, body, ctxRef.current);
      // Register a never-rejecting shadow in the single-flight slot so a keystroke
      // that schedules an autosave mid-finish drains onto us (and sees the id our
      // create set) rather than firing a second journal.create.
      const shadow = task.then(
        () => undefined,
        () => undefined,
      );
      inFlightRef.current = shadow;
      try {
        const finished = await task;
        // What is durable is the body the server STORED, not the one sent: the
        // caller adopts it for read mode, and must not then re-save it as an edit.
        durableTextRef.current = { title, body: finished.message };
        reporter.succeed('finish');
        reporter.succeed('body');
        if (generationRef.current === generation) reporter.publish('saved');
        return finished;
      } catch (error) {
        reporter.fail({ lane: 'finish' });
        if (generationRef.current === generation) reporter.publish('idle');
        throw error;
      } finally {
        if (inFlightRef.current === shadow) inFlightRef.current = null;
      }
    },
    [
      writeRefs,
      entryUnsettledRef,
      ctxRef,
      inFlightRef,
      timerRef,
      generationRef,
      durableTextRef,
      reporter,
    ],
  );
}

/**
 * Compose the tier + chord persisters: their refs (read by the writer), their
 * seeders (for load), and error-surfacing change wrappers sharing the save hint.
 */
function usePersistControls(
  entryIdRef: React.MutableRefObject<number | null>,
  reporter: SaveReporter,
  entryUnsettledRef: React.MutableRefObject<boolean>,
) {
  // Told of every sent tier write's outcome, in send order (#2935); a success
  // carries the tier the server reports storing.
  const tierOutcomeRef = useRef<TierOutcome>(() => undefined);
  const onTierOutcome = useCallback(
    (o: PersistOutcome<JournalClassification>) =>
      tierOutcomeRef.current(
        o.ok ? { seq: o.seq, ok: true, stored: o.stored?.classification ?? o.value } : o,
      ),
    [],
  );
  const {
    ref: classificationRef,
    change: changeClassification,
    seed: seedClassification,
  } = useRefPersist<JournalClassification>(
    entryIdRef,
    entryUnsettledRef,
    DEFAULT_TIER,
    classificationToPatch,
    onTierOutcome,
  );
  const {
    ref: chordRef,
    change: changeChord,
    seed: seedChord,
  } = useRefPersist<AspectChordValue>(entryIdRef, entryUnsettledRef, EMPTY_CHORD, chordToPatch);
  const seedPersist = useCallback(
    (tier: JournalClassification, chord: AspectChordValue): void => {
      seedClassification(tier);
      seedChord(chord);
    },
    [seedClassification, seedChord],
  );
  return {
    classificationRef,
    chordRef,
    seedPersist,
    tierOutcomeRef,
    persistClassification: useLanePersist(changeClassification, reporter, classificationFailure),
    persistChord: useLanePersist(changeChord, reporter, chordFailure),
  };
}

/** The tier/chord writers and seeds the draft saver hands on. */
function persistPorts(persist: ReturnType<typeof usePersistControls>) {
  return {
    changeClassification: persist.persistClassification,
    changeChord: persist.persistChord,
    seedPersist: persist.seedPersist,
    tierOutcomeRef: persist.tierOutcomeRef,
  };
}

/** Receives each sent tier write's outcome (#2935). */
type TierOutcome = (_outcome: TierWriteOutcome) => void;

/** The debounced save + immediate flush + atomic finish, over one shared ref bundle. */
type DraftWriters = SaveTimer & { finish: RunFinish };

/** Wire the three writers (debounced save, flush, atomic finish) over shared refs. */
function useDraftWriters(
  refs: SaveRunnerRefs & FinishRunnerRefs,
  delayMs: number,
  reporter: SaveReporter,
): DraftWriters {
  const setTyping = useCallback(() => reporter.publish('typing'), [reporter]);
  const run = useSaveRunner(refs, reporter);
  const { save, flush } = useSaveTimer(
    run,
    refs.timerRef,
    refs.entryIdRef,
    refs.generationRef,
    delayMs,
    setTyping,
  );
  const finish = useFinishWriter(refs, reporter);
  return { save, flush, finish };
}

/** The non-memoised inputs the writer reads through refs (kept fresh each render). */
interface MirroredInputs {
  onSaved?: () => void;
  onConflict?: () => void;
  ctx: SaveContext;
  entryUnsettled: boolean;
}

/** Mirror the latest non-memoised writer inputs onto their refs (no callback churn). */
function useMirroredInputs(
  onSavedRef: React.MutableRefObject<(() => void) | undefined>,
  onConflictRef: React.MutableRefObject<(() => void) | undefined>,
  ctxRef: React.MutableRefObject<SaveContext>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
  values: MirroredInputs,
): void {
  useEffect(() => {
    onSavedRef.current = values.onSaved;
    onConflictRef.current = values.onConflict;
    ctxRef.current = values.ctx;
    entryUnsettledRef.current = values.entryUnsettled;
  });
}

/** The stable refs the draft writer reads (created once, mirrored each render). */
interface DraftRefs {
  entryIdRef: React.MutableRefObject<number | null>;
  timerRef: TimerRef;
  inFlightRef: React.MutableRefObject<Promise<unknown> | null>;
  respondedRef: React.MutableRefObject<boolean>;
  onSavedRef: React.MutableRefObject<(() => void) | undefined>;
  onConflictRef: React.MutableRefObject<(() => void) | undefined>;
  ctxRef: React.MutableRefObject<SaveContext>;
  entryUnsettledRef: React.MutableRefObject<boolean>;
  generationRef: React.MutableRefObject<number>;
  durableTextRef: React.MutableRefObject<DraftText | null>;
  createKeyRef: React.MutableRefObject<CreateKey<SentPage> | null>;
}

/**
 * Create the draft writer's refs and keep the non-memoised ones mirrored.
 *
 * ``entryUnsettledRef`` gates every write: until an existing entry's load
 * settles, ``entryIdRef`` points at the real, unloaded entry with a blank body,
 * so a save (or tier/chord PATCH) would overwrite it. ``respondedRef`` makes a
 * weekly-prompt response write-once, and ``inFlightRef`` single-flights saves so
 * two id-less saves can't each fire ``journal.create``.
 */
function useDraftRefs(routeEntryId: number | null, values: MirroredInputs): DraftRefs {
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<unknown> | null>(null);
  const respondedRef = useRef(false);
  const onSavedRef = useRef(values.onSaved);
  const onConflictRef = useRef(values.onConflict);
  const ctxRef = useRef(values.ctx);
  const entryUnsettledRef = useRef(values.entryUnsettled);
  const generationRef = useRef(0);
  const durableTextRef = useRef<DraftText | null>(null);
  // One create key per page: the same lifetime as ``entryIdRef`` (#2936).
  const createKeyRef = useRef<CreateKey<SentPage> | null>(null);
  useMirroredInputs(onSavedRef, onConflictRef, ctxRef, entryUnsettledRef, values);
  return {
    entryIdRef,
    timerRef,
    inFlightRef,
    respondedRef,
    onSavedRef,
    onConflictRef,
    ctxRef,
    entryUnsettledRef,
    generationRef,
    durableTextRef,
    createKeyRef,
  };
}

function useDurableTextSeeder(durableTextRef: React.MutableRefObject<DraftText | null>) {
  return useCallback(
    (title: string, body: string) => {
      durableTextRef.current = { title, body };
    },
    [durableTextRef],
  );
}

/** Stable reads a save retry makes of the writer's live refs. */
function useRetryProbes(
  inFlightRef: React.MutableRefObject<Promise<unknown> | null>,
  classificationRef: React.MutableRefObject<JournalClassification>,
): Pick<RetrySource, 'isWriteInFlight' | 'displayedTier'> {
  const isWriteInFlight = useCallback(() => inFlightRef.current != null, [inFlightRef]);
  const displayedTier = useCallback(() => classificationRef.current, [classificationRef]);
  return { isWriteInFlight, displayedTier };
}

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  entryUnsettled: boolean,
  onSaved?: () => void,
  onConflict?: () => void,
) {
  const ledger = useSaveLedger();
  const { reporter } = ledger.ports;
  const [entryId, setEntryId] = useState<number | null>(routeEntryId);
  const refs = useDraftRefs(routeEntryId, { onSaved, onConflict, ctx, entryUnsettled });
  const persist = usePersistControls(refs.entryIdRef, reporter, refs.entryUnsettledRef);
  const cancelPending = useTimerCleanup(refs.timerRef);

  const { save, flush, finish } = useDraftWriters(
    { ...refs, classificationRef: persist.classificationRef, chordRef: persist.chordRef },
    delayMs,
    reporter,
  );
  const flushAndTrack = useCallback(
    async (...args: Parameters<typeof flush>) => {
      const result = await flush(...args);
      if (result.entryId != null) setEntryId(result.entryId);
      return result;
    },
    [flush],
  );
  const finishAndTrack = useCallback(
    async (...args: Parameters<typeof finish>) => {
      const finished = await finish(...args);
      setEntryId(finished.id);
      return finished;
    },
    [finish],
  );

  return {
    entryId,
    saveState: ledger.hint,
    ledger: ledger.ports,
    ...useRetryProbes(refs.inFlightRef, persist.classificationRef),
    save,
    flush: flushAndTrack,
    finish: finishAndTrack,
    ...persistPorts(persist),
    seedDurableText: useDurableTextSeeder(refs.durableTextRef),
    cancelPending,
  };
}

type StrRef = React.MutableRefObject<string>;

/** Raised when text changed during Finish could not then be saved. */
const UNSAVED_AFTER_FINISH_ERROR = 'Text changed during Finish could not be saved.';

/**
 * The body the server holds once every change made during the Finish write is
 * durable. The Finish response only knows the text it carried; if the body
 * changed while it was out, that newer text is saved (``flushForExit`` loops
 * until what it wrote is what the page holds) and the entry is re-read for the
 * server's sanitized copy -- again, if the body moved during the read. A save
 * that fails rejects, so the caller keeps the writer in the editor, never on a
 * read view of text the server does not hold.
 */
function useSettleStoredBody(bodyRef: StrRef, flushForExit: () => Promise<boolean>) {
  return useCallback(
    async (finished: FinishedEntry, sent: string): Promise<string> => {
      let stored = finished.message;
      let settled = sent;
      while (bodyRef.current !== settled) {
        if (!(await flushForExit())) throw new Error(UNSAVED_AFTER_FINISH_ERROR);
        settled = bodyRef.current;
        stored = (await journal.get(finished.id)).message;
      }
      return stored;
    },
    [bodyRef, flushForExit],
  );
}

/** Bind flush + finish to the latest title/body refs so callers pass no args. */
function useBoundWriters(
  flush: (_title: string, _body: string) => Promise<FlushResult>,
  finish: RunFinish,
  titleRef: StrRef,
  bodyRef: StrRef,
  adoptStoredBody: (_stored: string) => void,
): {
  flushNow: () => Promise<number | null>;
  flushDurableNow: () => Promise<number | null>;
  flushForExitNow: () => Promise<boolean>;
  finishNow: () => Promise<number>;
} {
  const flushNow = useCallback(
    async () => (await flush(titleRef.current, bodyRef.current)).entryId,
    [flush, titleRef, bodyRef],
  );
  const flushDurableNow = useCallback(async () => {
    const result = await flush(titleRef.current, bodyRef.current);
    return result.durable ? result.entryId : null;
  }, [flush, titleRef, bodyRef]);
  const flushForExitNow = useCallback(async () => {
    for (;;) {
      const requested = { title: titleRef.current, body: bodyRef.current };
      const result = await flush(requested.title, requested.body);
      if (!result.durable) return false;
      if (sameDraft(requested, titleRef.current, bodyRef.current)) return true;
    }
  }, [flush, titleRef, bodyRef]);
  const settleStoredBody = useSettleStoredBody(bodyRef, flushForExitNow);
  // Read mode shows, and promotes offsets into, the body as STORED, so it adopts
  // the server's copy of the latest text before it opens -- including text the
  // writer typed (or a fold-in added) while the Finish write was out.
  const finishNow = useCallback(async () => {
    const sent = bodyRef.current;
    const finished = await finish(titleRef.current, sent);
    adoptStoredBody(await settleStoredBody(finished, sent));
    return finished.id;
  }, [finish, titleRef, bodyRef, adoptStoredBody, settleStoredBody]);
  return { flushNow, flushDurableNow, flushForExitNow, finishNow };
}

/** Referentially-stable change handlers; each save reads the other field's ref. */
function useFieldHandlers(
  titleRef: StrRef,
  bodyRef: StrRef,
  save: (_t: string, _b: string) => void,
  setTitle: (_v: string) => void,
  setBody: (_v: string) => void,
) {
  const onChangeTitle = useCallback(
    (next: string) => {
      titleRef.current = next;
      setTitle(next);
      save(next, bodyRef.current);
    },
    [titleRef, bodyRef, save, setTitle],
  );
  const onChangeBody = useCallback(
    (next: string) => {
      bodyRef.current = next;
      setBody(next);
      save(titleRef.current, next);
    },
    [titleRef, bodyRef, save, setBody],
  );
  return { onChangeTitle, onChangeBody };
}

/** The pre-fill an entry opens with: a title and a body, either possibly ''. */
interface InitialText {
  title: string;
  body: string;
}

interface EntryState {
  title: string;
  body: string;
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  classification: JournalClassification;
  setClassification: (_tier: JournalClassification) => void;
  chord: AspectChordValue;
  setChord: (_next: AspectChordValue) => void;
  setTitle: (_v: string) => void;
  setBody: (_v: string) => void;
  titleRef: StrRef;
  bodyRef: StrRef;
  /** Exact server text captured during hydration, before any subsequent edit. */
  loadedTextRef: React.MutableRefObject<DraftText | null>;
  /** Set (to {@link LOAD_ERROR_MESSAGE}) when loading an existing entry failed. */
  loadError: string | null;
  /** Flips true once an existing entry's values have been applied to state. */
  loaded: boolean;
  /** Words typed while the entry was unloaded, held after its load until they
   *  can be put on the page and saved safely (#2935); null when there are none. */
  carryHold: CarryHold | null;
  setCarryHold: (_hold: CarryHold | null) => void;
  reflectionLevel?: ReflectionLevel;
  reflectionScopeKey?: string;
}

/** What the page held when it opened on an entry, before its load landed. */
interface CarryBaseline extends InitialText {
  entryId: number;
  /** The tier the page showed while the writer typed into it unloaded. */
  classification: JournalClassification;
}

/**
 * Words a load carried (#2935): what the writer typed into the unloaded page and
 * what that page opened with, so they can be merged onto the page as it stands
 * whenever they are put back, and the stricter tier the stored entry must move
 * to before they are saved (null when its stored tier is already as strict).
 */
interface CarryHold {
  typed: InitialText;
  baseline: InitialText;
  tier: JournalClassification | null;
  /** The tier the server held when the entry loaded: confirmed until a write says otherwise. */
  storedTier: JournalClassification;
}

interface MutableEntryState extends EntryState {
  /** Cleared (null) when a load succeeds, so a reconnect reload lifts the banner. */
  setLoadError: (_message: string | null) => void;
  /** The opening baseline, for the FIRST load of the route entry only (#2935). */
  carryBaselineRef: React.MutableRefObject<CarryBaseline | null>;
  setLoaded: (_loaded: boolean) => void;
  setReflectionLevel: (_level: ReflectionLevel | undefined) => void;
  setReflectionScopeKey: (_scopeKey: string | undefined) => void;
}

const REFLECTION_LEVELS = new Set<ReflectionLevel>(['week', 'stage', 'section', 'course']);

function reflectionLevelFromWire(value: string | null | undefined): ReflectionLevel | undefined {
  return value != null && REFLECTION_LEVELS.has(value as ReflectionLevel)
    ? (value as ReflectionLevel)
    : undefined;
}

/**
 * The refs that let a load keep words typed while the entry was unloaded
 * (#2935). The baseline is what the page opened with, tied to the route entry
 * id, and is used by that entry's first successful load only.
 */
function useCarryRefs(
  routeEntryId: number | null,
  initialText: InitialText,
  classification: JournalClassification,
) {
  const carryBaselineRef = useRef<CarryBaseline | null>(
    routeEntryId == null ? null : { entryId: routeEntryId, ...initialText, classification },
  );
  const [carryHold, setCarryHold] = useState<CarryHold | null>(null);
  return { carryBaselineRef, carryHold, setCarryHold };
}

/** Local fields and setters; server hydration stays in the smaller hook below. */
function useLocalEntryState(
  routeEntryId: number | null,
  initialText: InitialText,
  initialClassification: JournalClassification,
  initialReflectionLevel?: ReflectionLevel,
  initialReflectionScopeKey?: string,
): MutableEntryState {
  const initialTitle = singleLineTitle(initialText.title);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialText.body);
  const [status, setStatus] = useState<EntryStatus>('draft');
  const [classification, setClassification] =
    useState<JournalClassification>(initialClassification);
  const [chord, setChord] = useState<AspectChordValue>(EMPTY_CHORD);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reflectionLevel, setReflectionLevel] = useState(initialReflectionLevel);
  const [reflectionScopeKey, setReflectionScopeKey] = useState(initialReflectionScopeKey);
  const titleRef = useRef(initialTitle);
  const bodyRef = useRef(initialText.body);
  const loadedTextRef = useRef<DraftText | null>(null);
  const opening = { title: initialTitle, body: initialText.body };
  const carry = useCarryRefs(routeEntryId, opening, initialClassification);
  return {
    ...carry,
    title,
    body,
    status,
    setStatus,
    classification,
    setClassification,
    chord,
    setChord,
    setTitle,
    setBody,
    titleRef,
    bodyRef,
    loadedTextRef,
    loadError,
    loaded,
    reflectionLevel,
    reflectionScopeKey,
    setLoadError,
    setLoaded,
    setReflectionLevel,
    setReflectionScopeKey,
  };
}

/**
 * Keep the composed reflection's scope in step with the route that named it.
 *
 * ``useLocalEntryState`` seeds the scope from the route params ONCE, in a
 * ``useState`` initializer, while ``currentEntryId`` is read live from params on
 * every render — an asymmetry that leaves the Sources panel showing one review
 * while the save payload carries another the moment a caller navigates to this
 * screen with different params instead of pushing a fresh instance. Re-seeding
 * on a params change closes that.
 *
 * A LOADED entry still wins: ``useApplyLoadedEntry`` writes the scope stored on
 * the entry itself, and this effect does not re-run for it because the route
 * params it watches have not changed. Reopening a saved review by id therefore
 * shows that review's own scope, not whichever one the route last named.
 */
function useRouteScopeSync(
  state: MutableEntryState,
  routeReflectionLevel: ReflectionLevel | undefined,
  routeReflectionScopeKey: string | undefined,
): void {
  const { setReflectionLevel, setReflectionScopeKey } = state;
  useEffect(() => {
    setReflectionLevel(routeReflectionLevel);
    setReflectionScopeKey(routeReflectionScopeKey);
  }, [routeReflectionLevel, routeReflectionScopeKey, setReflectionLevel, setReflectionScopeKey]);
}

/**
 * The words this load must hold for later (#2935), or null. The baseline is
 * single-use and must name this entry, so nothing typed on one entry reaches
 * another; the tier is the escalation, if any, the carried words need first.
 */
function carryHoldFor(
  baseline: CarryBaseline | null,
  local: InitialText,
  server: InitialText,
  entry: JournalMessage,
): CarryHold | null {
  if (baseline?.entryId !== entry.id) return null;
  if (!reconcileUnloadedDraft(server, local, baseline).carried) return null;
  const stored = entry.classification ?? DEFAULT_TIER;
  return {
    typed: local,
    baseline: { title: baseline.title, body: baseline.body },
    tier: carriedTierEscalation(stored, baseline.classification),
    storedTier: stored,
  };
}

/**
 * Put the stored title and body on the page (#2935).
 *
 * The page and ``loadedTextRef`` always take the exact stored text, so the
 * durable-text seed only ever blesses what the server holds and an exit flush
 * never writes words the writer has not yet been able to see saved. Words typed
 * while this entry was unloaded are HELD, not dropped: ``useCarryRelease`` puts
 * them on the page and saves them once that is safe (after Edit on a finished
 * entry, and only under a tier at least as strict as the one they were typed
 * under).
 */
function applyServerText(state: MutableEntryState, entry: JournalMessage): void {
  const { titleRef, bodyRef, carryBaselineRef } = state;
  const server = { title: singleLineTitle(entry.title ?? ''), body: entry.message };
  const baseline = carryBaselineRef.current;
  carryBaselineRef.current = null;
  const local = { title: titleRef.current, body: bodyRef.current };
  state.setCarryHold(carryHoldFor(baseline, local, server, entry));
  state.loadedTextRef.current = server;
  titleRef.current = server.title;
  bodyRef.current = server.body;
  state.setTitle(server.title);
  state.setBody(server.body);
}

/** Put the stored status, tier, chord and scope on the page, and lift the gate. */
function applyServerFields(state: MutableEntryState, entry: JournalMessage): void {
  state.setStatus(entry.status ?? 'draft');
  state.setClassification(entry.classification ?? DEFAULT_TIER);
  state.setChord({
    primary: entry.primary_aspect ?? null,
    secondary: entry.secondary_aspect ?? null,
  });
  state.setReflectionLevel(reflectionLevelFromWire(entry.reflection_level));
  state.setReflectionScopeKey(entry.reflection_scope_key ?? undefined);
  state.setLoadError(null);
  state.setLoaded(true);
}

/**
 * Stable load applicator, separated so the state owner remains reviewably small.
 *
 * Its identity never changes: the load effect is keyed on it, so a dependency
 * that changed between renders would re-run the GET on every render. Every
 * setter and ref it touches is itself stable, so it reads them through a ref.
 */
function useApplyLoadedEntry(state: MutableEntryState): (_entry: JournalMessage) => void {
  const stateRef = useRef(state);
  stateRef.current = state;
  return useCallback((entry: JournalMessage) => {
    applyServerText(stateRef.current, entry);
    applyServerFields(stateRef.current, entry);
  }, []);
}

/** Drop the carry baseline once the screen is reused for a different entry, so
 *  words typed on the entry it opened on are never carried into another. */
function useDropCarryOnRouteChange(
  routeEntryId: number | null,
  carryBaselineRef: MutableEntryState['carryBaselineRef'],
): void {
  const openedOnRef = useRef(routeEntryId);
  useEffect(() => {
    if (routeEntryId !== openedOnRef.current) carryBaselineRef.current = null;
  }, [routeEntryId, carryBaselineRef]);
}

/** The entry's editable state (title/body/status/tier) + load-on-open, re-run on
 *  reconnect after a failed load (#2935). ``initialClassification`` pre-selects
 *  the tier for a fresh entry (e.g. the capture flow's intimate offramp); an
 *  existing entry's load overrides it. */
function useEntryState(
  routeEntryId: number | null,
  initialText: InitialText,
  initialClassification: JournalClassification,
  initialReflectionLevel?: ReflectionLevel,
  initialReflectionScopeKey?: string,
): EntryState {
  const state = useLocalEntryState(
    routeEntryId,
    initialText,
    initialClassification,
    initialReflectionLevel,
    initialReflectionScopeKey,
  );
  useRouteScopeSync(state, initialReflectionLevel, initialReflectionScopeKey);
  useDropCarryOnRouteChange(routeEntryId, state.carryBaselineRef);
  const apply = useApplyLoadedEntry(state);
  const { setLoadError } = state;
  const onError = useCallback(() => setLoadError(LOAD_ERROR_MESSAGE), [setLoadError]);
  useEntryLoad({
    routeEntryId,
    loaded: state.loaded,
    loadFailed: state.loadError != null,
    apply,
    onError,
  });
  return state;
}

interface ChoiceHandlers {
  onChangeClassification: (_tier: JournalClassification) => void;
  onChangeChord: (_next: AspectChordValue) => void;
}

/** The awaitable forms a save retry re-applies a tier or chord through. */
interface ChoiceAppliers {
  applyClassification: (_tier: JournalClassification) => Promise<void>;
  applyChord: (_chord: AspectChordValue) => Promise<void>;
}

/**
 * Reflect a choice optimistically, then persist it (create-time ref or PATCH);
 * a failed PATCH resolves to the prior value so the control reverts to the
 * truth, unless a later change superseded it (then it resolves null and we keep
 * that). Resolves once the write settles, so a retry can run choices in order.
 */
function useChoiceApplier<T>(
  setValue: (_value: T) => void,
  change: (_value: T) => Promise<T | null>,
): (_value: T) => Promise<void> {
  return useCallback(
    async (value: T) => {
      setValue(value);
      const revertTo = await change(value);
      if (revertTo != null) setValue(revertTo);
    },
    [change, setValue],
  );
}

/** Reflect a privacy/chord choice in local state, then persist it (ref or PATCH). */
function useChoiceHandlers(
  entry: EntryState,
  changeClassification: (_tier: JournalClassification) => Promise<JournalClassification | null>,
  changeChord: (_next: AspectChordValue) => Promise<AspectChordValue | null>,
): ChoiceHandlers & ChoiceAppliers {
  const applyClassification = useChoiceApplier(entry.setClassification, changeClassification);
  const applyChord = useChoiceApplier(entry.setChord, changeChord);
  const onChangeClassification = useCallback(
    (tier: JournalClassification) => void applyClassification(tier),
    [applyClassification],
  );
  const onChangeChord = useCallback(
    (next: AspectChordValue) => void applyChord(next),
    [applyChord],
  );
  return { onChangeClassification, onChangeChord, applyClassification, applyChord };
}

/**
 * Seed the persist refs from a loaded entry exactly once, so a failed re-tag
 * reverts to the entry's real tier/chord rather than the module default. The
 * guard keeps later optimistic changes (which own the refs themselves) from
 * being clobbered.
 */
function useSeedPersistOnLoad(
  entry: Pick<EntryState, 'loaded' | 'classification' | 'chord'>,
  seedPersist: (_tier: JournalClassification, _chord: AspectChordValue) => void,
): void {
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !entry.loaded) return;
    seededRef.current = true;
    seedPersist(entry.classification, entry.chord);
  }, [entry.loaded, entry.classification, entry.chord, seedPersist]);
}

/** Seed the exact durable body/title captured by the load callback, not later edits. */
function useSeedDurableTextOnLoad(
  entry: Pick<EntryState, 'loaded' | 'loadedTextRef'>,
  seedDurableText: (_title: string, _body: string) => void,
): void {
  const seededRef = useRef(false);
  useEffect(() => {
    const loaded = entry.loadedTextRef.current;
    if (seededRef.current || !entry.loaded || loaded == null) return;
    seededRef.current = true;
    seedDurableText(loaded.title, loaded.body);
  }, [entry.loaded, entry.loadedTextRef, seedDurableText]);
}

/**
 * Drop a debounce armed before the entry loaded (#2935). It holds text typed
 * into the unloaded page, which the load has since replaced; left armed, it
 * would fire once the gate lifts and write that stale text (for example an
 * untouched pre-fill) over the stored entry. Words worth keeping were already
 * captured as the carry hold, which saves them through its own path.
 */
function useDropStaleSaveOnLoad(loaded: boolean, cancelPending: () => void): void {
  useEffect(() => {
    if (loaded) cancelPending();
  }, [loaded, cancelPending]);
}

/** True when ``tier`` is at least as strict as the tier held words need. */
function strictEnough(hold: CarryHold, tier: JournalClassification): boolean {
  return hold.tier == null || !isTierLooser(tier, hold.tier);
}

/** Said by Finish while held words wait on a stricter tier (#2935). */
const CARRY_HELD_FINISH_ERROR = 'Cannot finish while carried words wait on a stricter tier.';

type TierSettled = () => void;

/** The writers the page uses, gated while a tier escalation is owed (#2935). */
interface HeldTextGate {
  saving: ReturnType<typeof useDebouncedSave>;
  /** True while page text must not be written: an escalation is in flight or failed. */
  heldRef: React.MutableRefObject<boolean>;
  /** Told after every tier write settles (success or not), to re-check release. */
  tierSettledRef: React.MutableRefObject<TierSettled>;
  /** Told of every sent tier write's outcome: the only proof of a tier. */
  tierOutcomeRef: React.MutableRefObject<TierOutcome>;
  /** Tier writes on their way (the writer's, a retry's, or an escalation). */
  tierWritesRef: React.MutableRefObject<number>;
  /** The tiers those in-flight writes carry. */
  inFlightTiersRef: React.MutableRefObject<JournalClassification[]>;
  /** True while any tier write is on its way, for what the page offers. */
  tierWriteInFlight: boolean;
}

/**
 * Gate every page-text writer while a privacy escalation is owed (#2935).
 *
 * Words typed while the control shows the stricter tier must never reach a row
 * still stored under the looser one. So while ``heldRef`` is set (from the
 * moment the escalation is sent until a tier at least as strict is confirmed),
 * the debounced save is dropped (the next release saves the page as it then
 * stands), every flush reports not-durable, and Finish refuses. Every tier write reports back through
 * ``tierSettledRef`` so the release can react to a retry or the writer's choice.
 */
function useHeldTextGate(
  saving: ReturnType<typeof useDebouncedSave>,
  carryHeld: boolean,
): HeldTextGate {
  const heldRef = useRef(false);
  // Held words (even with no escalation owed, e.g. a finished entry after
  // Cancel) mean no flush may report the page saved: the words are not on it.
  const carryHeldRef = useRef(carryHeld);
  carryHeldRef.current = carryHeld;
  const tierSettledRef = useRef<TierSettled>(() => undefined);
  const { save, flush, finish, changeClassification, entryId } = saving;
  const gatedSave = useCallback(
    (title: string, body: string) => {
      if (!heldRef.current) save(title, body);
    },
    [save],
  );
  const gatedFlush = useCallback(
    async (title: string, body: string): Promise<FlushResult> =>
      heldRef.current || carryHeldRef.current ? { durable: false, entryId } : flush(title, body),
    [flush, entryId],
  );
  const gatedFinish = useGatedFinish(finish, heldRef);
  const { track, ...writes } = useTierWriteCount();
  const queuedChange = useTierWriteQueue(changeClassification);
  const reportingChange = useCallback(
    async (tier: JournalClassification) => {
      const revertTo = await track(tier, () => queuedChange(tier));
      tierSettledRef.current();
      return revertTo;
    },
    [queuedChange, track],
  );
  const gated = {
    ...saving,
    save: gatedSave,
    flush: gatedFlush,
    finish: gatedFinish,
    changeClassification: reportingChange,
  };
  return {
    saving: gated,
    heldRef,
    tierSettledRef,
    ...writes,
    tierOutcomeRef: saving.tierOutcomeRef,
  };
}

/** Finish refuses while held words wait on a stricter tier (#2935). */
function useGatedFinish(finish: RunFinish, heldRef: React.MutableRefObject<boolean>): RunFinish {
  return useCallback<RunFinish>(
    async (title, body) => {
      if (heldRef.current) throw new Error(CARRY_HELD_FINISH_ERROR);
      return finish(title, body);
    },
    [finish, heldRef],
  );
}

/** A tier write the queue has not sent yet, and the caller waiting on it. */
interface QueuedTierWrite {
  tier: JournalClassification;
  resolve: (_revertTo: JournalClassification | null) => void;
}

/**
 * Serialize this entry's tier writes (#2935): at most one tier PATCH is ever in
 * flight, so the server commits them in the order they are sent and responses
 * arrive in that order. Every writer (taps, the #2930 retry, the escalation)
 * goes through here. A write asked for while one is out waits; a newer one
 * replaces it (last tap wins), and the replaced caller resolves as superseded
 * without anything being sent. The control's own state still moves at once.
 */
function useTierWriteQueue(
  change: (_tier: JournalClassification) => Promise<JournalClassification | null>,
): (_tier: JournalClassification) => Promise<JournalClassification | null> {
  const busyRef = useRef(false);
  const nextRef = useRef<QueuedTierWrite | null>(null);
  const send = useCallback(
    async (tier: JournalClassification): Promise<JournalClassification | null> => {
      busyRef.current = true;
      try {
        const revertTo = await change(tier);
        // A newer choice is already queued and owns the control: never revert
        // the screen over it (the same rule useRefPersist applies to a superseded
        // write).
        return nextRef.current == null ? revertTo : null;
      } finally {
        busyRef.current = false;
        const next = nextRef.current;
        nextRef.current = null;
        if (next != null) void send(next.tier).then(next.resolve);
      }
    },
    [change],
  );
  return useCallback(
    (tier: JournalClassification) => {
      if (!busyRef.current) return send(tier);
      return new Promise<JournalClassification | null>((resolve) => {
        nextRef.current?.resolve(null);
        nextRef.current = { tier, resolve };
      });
    },
    [send],
  );
}

/** Count tier writes in flight: a ref for decisions, a flag for rendering. */
function useTierWriteCount() {
  const tierWritesRef = useRef(0);
  const inFlightTiersRef = useRef<JournalClassification[]>([]);
  const [tierWriteInFlight, setTierWriteInFlight] = useState(false);
  const track = useCallback(
    async <T,>(tier: JournalClassification, write: () => Promise<T>): Promise<T> => {
      tierWritesRef.current += 1;
      inFlightTiersRef.current = [...inFlightTiersRef.current, tier];
      setTierWriteInFlight(true);
      try {
        return await write();
      } finally {
        tierWritesRef.current -= 1;
        const at = inFlightTiersRef.current.indexOf(tier);
        inFlightTiersRef.current = inFlightTiersRef.current.filter((_t, i) => i !== at);
        setTierWriteInFlight(tierWritesRef.current > 0);
      }
    },
    [],
  );
  return { tierWritesRef, inFlightTiersRef, tierWriteInFlight, track };
}

/** Merge held words onto the page as it now stands, lift the gate, and save. */
function useCarryPutBack(
  entry: EntryState,
  save: (_title: string, _body: string) => void,
  heldRef: React.MutableRefObject<boolean>,
  setWaiting: (_waiting: boolean) => void,
): (_hold: CarryHold) => void {
  const { setCarryHold, titleRef, bodyRef, setTitle, setBody } = entry;
  return useCallback(
    (hold: CarryHold) => {
      const page = { title: titleRef.current, body: bodyRef.current };
      const merged = reconcileUnloadedDraft(page, hold.typed, hold.baseline);
      setCarryHold(null);
      setWaiting(false);
      heldRef.current = false;
      titleRef.current = merged.title;
      bodyRef.current = merged.body;
      setTitle(merged.title);
      setBody(merged.body);
      save(merged.title, merged.body);
    },
    [setCarryHold, setWaiting, heldRef, titleRef, bodyRef, setTitle, setBody, save],
  );
}

/**
 * Whichever confirmed write is strict enough first puts the words back; any
 * later one (a slower escalation) finds nothing held and changes nothing.
 */
function usePutBackOnce(
  holdRef: React.MutableRefObject<CarryHold | null>,
  putBack: (_hold: CarryHold) => void,
): (_hold: CarryHold) => void {
  return useCallback(
    (hold: CarryHold) => {
      if (holdRef.current !== hold) return;
      holdRef.current = null;
      putBack(hold);
    },
    [holdRef, putBack],
  );
}

/**
 * The server-confirmed tier (#2935): the newest accepted write (by send order),
 * else the tier the entry loaded with; null while a newer write has failed,
 * since a failed response does not say what the server committed.
 */
function useConfirmedTier(
  tierOutcomeRef: React.MutableRefObject<TierOutcome>,
): (_hold: CarryHold) => JournalClassification | null {
  const stateRef = useRef(LOADED_TIER_STATE);
  tierOutcomeRef.current = (outcome) => {
    stateRef.current = confirmTierWrite(stateRef.current, outcome);
  };
  return useCallback((hold: CarryHold) => knownTier(stateRef.current, hold.storedTier), []);
}

interface CarryEscalationState {
  escalatingRef: React.MutableRefObject<boolean>;
  setWaiting: (_waiting: boolean) => void;
  holdRef: React.MutableRefObject<CarryHold | null>;
}

/**
 * Send the escalation held words need (#2935). It chooses only WHAT to send:
 * the stricter of the tier on screen and the typed-under tier (the planRetry
 * rule, via isTierLooser), so nothing looser than the screen is ever sent. It
 * never releases anything itself: release follows confirmed server writes
 * alone (``tierSettledRef``). Tier writes are serialized (``useTierWriteQueue``),
 * so no later write can land before an earlier one; words still held when it
 * settles wait, with Retry.
 */
function useCarryEscalation(
  retrySource: Pick<RetrySource, 'applyClassification' | 'displayedTier'>,
  gate: Pick<HeldTextGate, 'heldRef'>,
  state: CarryEscalationState,
): (_hold: CarryHold) => Promise<void> {
  const { applyClassification, displayedTier } = retrySource;
  const { heldRef } = gate;
  const { escalatingRef, setWaiting, holdRef } = state;
  return useCallback(
    async (hold: CarryHold) => {
      const shown = displayedTier();
      const sent = carriedTierEscalation(shown, hold.tier ?? shown) ?? shown;
      escalatingRef.current = true;
      heldRef.current = true;
      try {
        await applyClassification(sent);
      } finally {
        escalatingRef.current = false;
      }
      if (holdRef.current === hold) setWaiting(true);
    },
    [applyClassification, displayedTier, heldRef, escalatingRef, setWaiting, holdRef],
  );
}

/**
 * Put held carried words back on the page and save them (#2935), as one normal
 * debounced autosave the save indicator reports.
 *
 * Privacy tiers only ever escalate: when the words were typed under a stricter
 * tier than the stored one, the entry is first moved to that tier through the
 * ordinary tier writer, with every page-text write gated meanwhile. The words go
 * back only once a tier at least that strict is confirmed. If the move fails,
 * they stay held OFF the page (and ``carryWaitingTier`` says so), the gate stays
 * on, and they return on the first later confirmation of a tier at least that
 * strict: a #2930 retry of the failed tier, or the writer choosing one. A looser
 * choice lifts nothing; leaving without the words is the held-exit guard's
 * explicit choice, never a side effect.
 */
function useCarryRelease(
  entry: EntryState,
  save: (_title: string, _body: string) => void,
  retrySource: RetrySource,
  gate: HeldTextGate,
): Pick<AutosaveApi, 'releaseCarry' | 'resendCarryTier' | 'carryWaitingTier' | 'carryRetryReady'> {
  const { heldRef, tierSettledRef, tierWritesRef, tierOutcomeRef, inFlightTiersRef } = gate;
  const [waiting, setWaiting] = useState(false);
  const holdRef = useRef(entry.carryHold);
  holdRef.current = entry.carryHold;
  const escalatingRef = useRef(false);
  const confirmedTier = useConfirmedTier(tierOutcomeRef);
  const putBack = usePutBackOnce(holdRef, useCarryPutBack(entry, save, heldRef, setWaiting));
  const escalate = useCarryEscalation(retrySource, gate, { escalatingRef, setWaiting, holdRef });

  const releaseCarry = useCallback(async () => {
    const hold = holdRef.current;
    if (hold == null || escalatingRef.current || heldRef.current) return;
    // Stored already at least as strict as the typed-under tier: nothing is owed.
    if (hold.tier == null) {
      putBack(hold);
      return;
    }
    await escalate(hold);
  }, [heldRef, putBack, escalate]);
  // Retry, from the footer or the leave dialog: re-send the tier the words were
  // typed under. Only a confirmed escalation puts them back (#2935).
  const resendCarryTier = useCallback(async () => {
    const hold = holdRef.current;
    // Never on top of another tier write: it could land after, and lower, it.
    if (hold == null || escalatingRef.current || tierWritesRef.current > 0) return;
    await escalate(hold);
  }, [escalate, tierWritesRef]);
  tierSettledRef.current = () => {
    const hold = holdRef.current;
    // Release only when the tier the server CONFIRMED is at least as strict as
    // the typed-under tier. Failures and optimistic taps never count, and while a
    // looser choice of the writer's is still out, the words stay held.
    if (hold == null || !heldRef.current) return;
    if (inFlightTiersRef.current.some((tier) => !strictEnough(hold, tier))) return;
    const known = confirmedTier(hold);
    if (known != null && strictEnough(hold, known)) putBack(hold);
  };
  return {
    releaseCarry,
    resendCarryTier,
    carryWaitingTier: waiting ? (entry.carryHold?.tier ?? null) : null,
    carryRetryReady: waiting && !gate.tierWriteInFlight,
  };
}

/**
 * Seed the persist ref for a NEW entry (no id to load) with the pre-set tier once
 * on mount, so the first ``journal.create`` carries it — the capture flow's
 * intimate offramp lands a genuinely intimate entry, not the personal default.
 * Runs only for a fresh entry; an existing entry is seeded by its load instead.
 */
function useSeedPersistOnNew(
  routeEntryId: number | null,
  initialClassification: JournalClassification,
  seedPersist: (_tier: JournalClassification, _chord: AspectChordValue) => void,
): void {
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || routeEntryId != null) return;
    seededRef.current = true;
    seedPersist(initialClassification, EMPTY_CHORD);
  }, [routeEntryId, initialClassification, seedPersist]);
}

interface AutosaveBindings extends ChoiceHandlers {
  entryId: number | null;
  saveState: SaveState;
  retrySource: RetrySource;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  flush: () => Promise<number | null>;
  flushDurable: () => Promise<number | null>;
  flushForExit: () => Promise<boolean>;
  finish: () => Promise<number>;
}

/** Project internal entry/persistence state onto the screen's autosave contract. */
function buildAutosaveApi(
  entry: EntryState,
  bindings: AutosaveBindings &
    Pick<AutosaveApi, 'releaseCarry' | 'resendCarryTier' | 'carryWaitingTier' | 'carryRetryReady'>,
  controlsLocked: boolean,
  loadedFromServer: boolean,
): AutosaveApi {
  return {
    title: entry.title,
    body: entry.body,
    status: entry.status,
    setStatus: entry.setStatus,
    classification: entry.classification,
    chord: entry.chord,
    loadError: entry.loadError,
    carryHeld: entry.carryHold != null,
    reflectionLevel: entry.reflectionLevel,
    reflectionScopeKey: entry.reflectionScopeKey,
    controlsLocked,
    loadedFromServer,
    ...bindings,
  };
}

/** Gather the writers a save retry re-sends through into one stable object. */
function useRetrySource(
  saving: Pick<RetrySource, 'ledger' | 'displayedTier' | 'isWriteInFlight'>,
  retryBody: () => Promise<unknown>,
  { applyClassification, applyChord }: ChoiceAppliers,
): RetrySource {
  const { ledger, displayedTier, isWriteInFlight } = saving;
  return useMemo(
    () => ({ ledger, displayedTier, retryBody, applyClassification, applyChord, isWriteInFlight }),
    [ledger, displayedTier, retryBody, applyClassification, applyChord, isWriteInFlight],
  );
}

/** Replace the local body with the server's stored copy (after Finish only). */
function useAdoptStoredBody(bodyRef: StrRef, setBody: (_v: string) => void) {
  return useCallback(
    (stored: string) => {
      bodyRef.current = stored;
      setBody(stored);
    },
    [bodyRef, setBody],
  );
}

/** Bind the draft writer to the entry's live fields and local choice state. */
function useAutosaveBindings(
  entry: EntryState,
  saving: ReturnType<typeof useDebouncedSave>,
): AutosaveBindings {
  const { onChangeTitle, onChangeBody } = useFieldHandlers(
    entry.titleRef,
    entry.bodyRef,
    saving.save,
    entry.setTitle,
    entry.setBody,
  );
  const adoptStoredBody = useAdoptStoredBody(entry.bodyRef, entry.setBody);
  const { flushNow, flushDurableNow, flushForExitNow, finishNow } = useBoundWriters(
    saving.flush,
    saving.finish,
    entry.titleRef,
    entry.bodyRef,
    adoptStoredBody,
  );
  const { applyClassification, applyChord, ...choices } = useChoiceHandlers(
    entry,
    saving.changeClassification,
    saving.changeChord,
  );
  const retrySource = useRetrySource(saving, flushNow, { applyClassification, applyChord });
  return {
    entryId: saving.entryId,
    saveState: saving.saveState,
    retrySource,
    onChangeTitle,
    onChangeBody,
    flush: flushNow,
    flushDurable: flushDurableNow,
    flushForExit: flushForExitNow,
    finish: finishNow,
    ...choices,
  };
}

/** Owns the entry's text + debounced draft autosave (create-then-update). */
function useJournalAutosave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  initialText: InitialText,
  initialClassification: JournalClassification,
  onSaved?: () => void,
  onConflict?: () => void,
): AutosaveApi {
  const entry = useEntryState(
    routeEntryId,
    initialText,
    initialClassification,
    ctx.reflectionLevel,
    ctx.reflectionScopeKey,
  );
  // An existing entry is "unsettled" until its load settles: entry.loaded flips
  // true only in the success apply, so it stays false through both the in-flight
  // and failed-load windows (and is irrelevant for a new entry — routeEntryId is
  // null). Gate the writer + controls on this so neither touches an unseen entry.
  const entryUnsettled = routeEntryId != null && !entry.loaded;
  const saving = useDebouncedSave(routeEntryId, delayMs, ctx, entryUnsettled, onSaved, onConflict);
  useSeedPersistOnLoad(entry, saving.seedPersist);
  useSeedDurableTextOnLoad(entry, saving.seedDurableText);
  useDropStaleSaveOnLoad(entry.loaded, saving.cancelPending);
  useSeedPersistOnNew(routeEntryId, initialClassification, saving.seedPersist);
  const gate = useHeldTextGate(saving, entry.carryHold != null);
  const bindings = useAutosaveBindings(entry, gate.saving);
  const carry = useCarryRelease(entry, saving.save, bindings.retrySource, gate);
  return buildAutosaveApi(
    entry,
    { ...bindings, ...carry },
    entryUnsettled,
    routeEntryId != null && entry.loaded,
  );
}

/** The Sources toggle's host ref, which the composer hands focus back to. */
type SourcesToggleRef = React.RefObject<React.ComponentRef<typeof TouchableOpacity> | null>;

/** The Sources toggle's wiring: what it opens, and the ref focus returns to on close. */
interface SourcesToggle {
  onOpen: () => void;
  ref: SourcesToggleRef;
}

interface WritingColumnProps {
  title: string;
  body: string;
  saveState: SaveState;
  classification: JournalClassification;
  chord: AspectChordValue;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  onChangeClassification: (_tier: JournalClassification) => void;
  onChangeChord: (_next: AspectChordValue) => void;
  /** Retry: re-send what failed (#2930), or held words' tier (#2935); and the held hint. */
  onRetrySave: SaveFooterActions;
  onFinish?: () => void;
  /** True while the Finish write is in flight; drives the busy/disabled control. */
  finishing: boolean;
  /** Set (to {@link FINISH_ERROR_MESSAGE}) when the Finish write failed. */
  finishError: string | null;
  bodyPlaceholder: string;
  /**
   * Disables the tier + chord controls until an existing entry's load settles
   * (still in flight or failed), so they never write against an unseen entry.
   */
  controlsDisabled: boolean;
  /** Reflection mode: track the body caret so a folded quote lands at the cursor. */
  onBodySelectionChange?: LiveMarkdownBodyProps['onBodySelectionChange'];
  /**
   * Opens the rereadable source feed while composing a reflection; focus comes
   * back to this toggle once the panel closes (#2883).
   */
  sources?: SourcesToggle;
  /** Phone layout: secondary actions keep their names for a11y but show icon-only. */
  compactControls: boolean;
}

/** Quiet primary control to mark a draft finished. */
function FinishControl({ onFinish, finishing }: { onFinish: () => void; finishing: boolean }) {
  return (
    <Button
      variant="tertiary"
      onPress={onFinish}
      accessibilityLabel="Mark this entry finished"
      testID="journal-finish-button"
      label="Finish"
      busy={finishing}
      disabled={finishing}
      style={styles.writingPrimaryControl}
    />
  );
}

/** The privacy-tier + Aspect-chord choosers, both gated off until load settles. */
function EntryTagControls({
  classification,
  chord,
  onChangeClassification,
  onChangeChord,
  controlsDisabled,
}: Pick<
  WritingColumnProps,
  'classification' | 'chord' | 'onChangeClassification' | 'onChangeChord' | 'controlsDisabled'
>) {
  return (
    <>
      <PrivacyTierControl
        value={classification}
        onChange={onChangeClassification}
        disabled={controlsDisabled}
      />
      <AspectChordControl value={chord} onChange={onChangeChord} disabled={controlsDisabled} />
    </>
  );
}

/** The wrapping title grows with its lines so none are hidden in an inner textarea. */
function GrowingTitle({
  title,
  onChangeTitle,
  onSubmit,
}: Pick<WritingColumnProps, 'title' | 'onChangeTitle'> & { onSubmit: () => void }) {
  const growth = useGrowingFieldHeight(TITLE_MIN_HEIGHT);
  return (
    <TextInput
      style={[styles.titleInput, writingFieldFocus, growth.style]}
      value={title}
      onChangeText={(next) => onChangeTitle(singleLineTitle(next))}
      onContentSizeChange={growth.onContentSizeChange}
      onSubmitEditing={onSubmit}
      placeholder="Title"
      placeholderTextColor={colors.paper.inkSoft}
      selectionColor={writingField.caret}
      cursorColor={writingField.caret}
      accessibilityLabel="Entry title"
      testID="journal-title-input"
      multiline
      numberOfLines={1}
      blurOnSubmit
      returnKeyType="next"
      scrollEnabled={false}
    />
  );
}

/** The title + growing body inputs (the raw editable text of the entry). */
function WritingFields(
  props: Pick<
    WritingColumnProps,
    'title' | 'body' | 'onChangeTitle' | 'onChangeBody' | 'onBodySelectionChange'
  > & { bodyPlaceholder: string },
) {
  const bodyInputRef = useRef<TextInput>(null);
  return (
    <>
      <GrowingTitle
        title={props.title}
        onChangeTitle={props.onChangeTitle}
        onSubmit={() => bodyInputRef.current?.focus()}
      />
      <View style={styles.hairline} />
      <LiveMarkdownBody
        body={props.body}
        onChangeBody={props.onChangeBody}
        onBodySelectionChange={props.onBodySelectionChange}
        bodyPlaceholder={props.bodyPlaceholder}
        inputRef={bodyInputRef}
      />
    </>
  );
}

/**
 * The line under the body: the save state on the left, the live word count on
 * the right.
 *
 * The count follows the BODY only — the prose being produced, not the label on
 * it — and is deliberately not a live region: announcing a new total on every
 * keystroke would make the page unusable with a screen reader, and the count is
 * reference, never a prompt. It stays silent at zero (see ``wordCountLabel``),
 * so an untouched page still opens as a blank page rather than a scoreboard.
 */
function WritingFooter({
  body,
  saveState,
  actions,
}: {
  body: string;
  saveState: SaveState;
  actions: SaveFooterActions;
}) {
  const { retry: onRetry, held } = actions;
  const words = useMemo(() => countWords(body), [body]);
  const canRetry = held == null ? saveState === 'error' : held.canRetry;
  return (
    <View style={styles.writingFooter}>
      <View style={styles.saveStatusRow}>
        <Text style={styles.savedHint} testID="journal-save-hint">
          {held?.label ?? savedHintLabel(saveState)}
        </Text>
        {canRetry ? (
          <TouchableOpacity
            style={styles.saveRetry}
            onPress={() => void onRetry()}
            accessibilityRole="button"
            accessibilityLabel="Retry saving this entry"
            testID="journal-save-retry"
          >
            <RefreshCw color={accent.primary} size={18} accessible={false} />
            <Text style={styles.saveRetryLabel}>Retry</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={styles.savedHint} testID="journal-word-count">
        {wordCountLabel(words)}
      </Text>
    </View>
  );
}

/**
 * The camera — the writing surface's door to the existing capture flow.
 *
 * An icon in the exit row, directly left of the close X, rather than a camera
 * embedded in the page: the capture route already owns the whole multi-page
 * session, its privacy gate and its transcription run, and inlining any of that
 * would fork a paid OCR path. Glyph over word (DESIGN.md): the full phrase is its
 * accessible name. Offered while writing only; a finished page is read, not
 * added to.
 */
function PhotographPageButton({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.entryIconButton}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={PHOTOGRAPH_PAGE_HINT}
      testID="journal-photograph-page"
    >
      <View accessible={false} testID="journal-photograph-page-icon">
        <Camera
          color={accent.primary}
          size={NAV_ICON_SIZE}
          strokeWidth={NAV_ICON_STROKE}
          accessible={false}
        />
      </View>
    </TouchableOpacity>
  );
}

function ReflectionSourcesButton({
  toggle,
  compact,
}: {
  toggle?: SourcesToggle;
  compact: boolean;
}): React.JSX.Element | null {
  return toggle ? (
    <TouchableOpacity
      ref={toggle.ref}
      style={styles.writingSecondaryControl}
      onPress={toggle.onOpen}
      accessibilityRole="button"
      accessibilityLabel="Open the sources to reread earlier writing and gather quotes"
      testID="reflection-sources-toggle"
    >
      <View accessible={false} testID="reflection-sources-icon">
        <BookOpen color={accent.primary} size={18} accessible={false} />
      </View>
      {compact ? null : <Text style={styles.writingControlLabel}>Sources</Text>}
    </TouchableOpacity>
  ) : null;
}

/**
 * The page's one unbroken action rail, with any Finish error centred beneath it.
 *
 * Balanced: two equal flanks hold Finish on the rail's centre, under the text
 * box. Sources lives in the trailing flank, so neither control shifts sideways
 * when the first keystroke makes Finish appear.
 */
function WritingControls({
  onFinish,
  finishing,
  finishError,
  sources,
  compactControls,
}: Pick<
  WritingColumnProps,
  'onFinish' | 'finishing' | 'finishError' | 'sources' | 'compactControls'
>): React.JSX.Element {
  return (
    <>
      <View style={styles.writingControlsRow} testID="journal-writing-controls">
        <View style={styles.writingControlsSide} testID="journal-writing-controls-leading" />
        {onFinish ? <FinishControl onFinish={onFinish} finishing={finishing} /> : null}
        <View
          style={[styles.writingControlsSide, styles.writingControlsTrailing]}
          testID="journal-writing-controls-trailing"
        >
          <ReflectionSourcesButton toggle={sources} compact={compactControls} />
        </View>
      </View>
      {finishError == null ? null : (
        <Text style={[styles.marginError, styles.finishError]} testID="journal-finish-error">
          {finishError}
        </Text>
      )}
    </>
  );
}

/** The scrollable writing column (title + growing body + save hint). */
function WritingColumn(props: WritingColumnProps): React.JSX.Element {
  return (
    <View style={styles.writingColumn}>
      <View style={styles.writingColumnContent}>
        <WritingColumnContent {...props} />
      </View>
    </View>
  );
}

/** The writing column's content, separate from the two wrappers that make it grow. */
function WritingColumnContent({
  title,
  body,
  saveState,
  classification,
  chord,
  onChangeTitle,
  onChangeBody,
  onChangeClassification,
  onChangeChord,
  onRetrySave,
  onFinish,
  finishing,
  finishError,
  bodyPlaceholder,
  controlsDisabled,
  onBodySelectionChange,
  sources,
  compactControls,
}: WritingColumnProps) {
  return (
    <>
      <EntryTagControls
        classification={classification}
        chord={chord}
        onChangeClassification={onChangeClassification}
        onChangeChord={onChangeChord}
        controlsDisabled={controlsDisabled}
      />
      <WritingFields
        title={title}
        body={body}
        onChangeTitle={onChangeTitle}
        onChangeBody={onChangeBody}
        onBodySelectionChange={onBodySelectionChange}
        bodyPlaceholder={bodyPlaceholder}
      />
      <WritingFooter body={body} saveState={saveState} actions={onRetrySave} />
      <WritingControls
        onFinish={onFinish}
        finishing={finishing}
        finishError={finishError}
        sources={sources}
        compactControls={compactControls}
      />
    </>
  );
}

/**
 * The margin's account of a resonance failure — a rejected pass, or a check-off
 * that did not go through.
 *
 * Rendered above whatever the margin already holds rather than only in place of
 * it, because a pending suggestion card is itself margin content: an error that
 * only had the empty-margin branch could not appear in the one state that
 * produces a failed check-off. ``accessibilityLiveRegion`` announces it, so the
 * silence that fix removed is not merely relocated to another medium.
 */
function ResonanceMargin({ error }: { error: string | null }) {
  return error ? (
    <Text
      style={styles.marginError}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      testID="journal-resonance-error"
    >
      {error}
    </Text>
  ) : null;
}

/**
 * The server's account of a pass that produced no margin notes.
 *
 * Warm paper tone rather than the error red beside it, because this is not a
 * failure: the pass ran, the wallet was put back, and there was simply nothing
 * to pin. Rendered above whatever the margin already holds so the writer sees
 * it even when earlier notes are still on the page — pressing the button and
 * getting no visible change is precisely the reported bug.
 */
function NoNotesNotice({ message }: { message: string | null }) {
  return message == null ? null : (
    <Text
      style={styles.marginNotice}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      testID="journal-resonance-no-notes"
    >
      {message}
    </Text>
  );
}

/** The read-mode quote surface: the promoted-quote list plus its UI gestures. */
interface QuotePromotion {
  quotes: PromotedQuote[];
  /** Warm, declinable copy for the latest failed promote/remove; null otherwise. */
  hint: string | null;
  /** True while a promote POST is in flight; drives the in-flight notice + busy control. */
  promoting: boolean;
  /** True briefly after a successful promote; drives the transient success notice. */
  promoted: boolean;
  /** Re-post the last failed span with the same anchors; null unless a promote failed. */
  retryPromote: (() => Promise<void>) | null;
  /** Re-read the quotes after an edited save re-anchored or staled them. */
  refresh: () => Promise<void>;
  /** True while the reader is choosing a span in the selection TextInput. */
  selecting: boolean;
  /** The quote whose "Remove promotion" affordance is currently revealed, if any. */
  removeTargetId: number | null;
  startSelecting: () => void;
  cancelSelecting: () => void;
  onSelectionChange: (_span: CodePointSpan) => void;
  confirmSelection: () => Promise<void>;
  onQuotePress: (_quote: PromotedQuote) => void;
  confirmRemove: () => void;
  /** Dismiss the revealed remove card without removing (tap elsewhere in the body). */
  dismissRemove: () => void;
  /** The one-time note in front of "Promote a quote"; its ``onPress`` is the button's. */
  explainer: PromoteExplainerGate;
}

/** The gesture slice of {@link QuotePromotion} owned by {@link useQuoteInteraction}. */
type QuoteInteraction = Omit<
  QuotePromotion,
  'quotes' | 'hint' | 'promoting' | 'promoted' | 'retryPromote' | 'refresh' | 'explainer'
>;

/** The read-mode selection/removal gestures over the {@link usePromotions} state. */
function useQuoteInteraction(
  promote: (_start: number, _end: number) => Promise<void>,
  removePromotion: (_id: number) => Promise<void>,
): QuoteInteraction {
  const [selecting, setSelecting] = useState(false);
  const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
  // The latest selection, held in a ref so a keystroke-free selection change
  // doesn't re-render the read-only surface until the reader confirms.
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const startSelecting = useCallback(() => {
    setRemoveTargetId(null);
    selectionRef.current = { start: 0, end: 0 };
    setSelecting(true);
  }, []);
  const cancelSelecting = useCallback(() => setSelecting(false), []);
  // The surface converts the native UTF-16 selection to a code-point span; store
  // it verbatim so ``confirmSelection`` posts anchors in the API's code-point unit.
  const onSelectionChange = useCallback((span: CodePointSpan) => {
    selectionRef.current = span;
  }, []);
  // Leave selection mode first so a 422 returns the reader to their place in the
  // read view; ``promote`` never throws (it maps failures to a hint). The surface
  // only enables confirm for a non-empty span, so no empty-span guard is needed.
  const confirmSelection = useCallback(async () => {
    const { start, end } = selectionRef.current;
    setSelecting(false);
    await promote(start, end);
  }, [promote]);
  const onQuotePress = useCallback((quote: PromotedQuote) => setRemoveTargetId(quote.id), []);
  const confirmRemove = useCallback(() => {
    const id = removeTargetId;
    setRemoveTargetId(null);
    if (id != null) void removePromotion(id);
  }, [removeTargetId, removePromotion]);
  const dismissRemove = useCallback(() => setRemoveTargetId(null), []);

  return {
    selecting,
    removeTargetId,
    startSelecting,
    cancelSelecting,
    onSelectionChange,
    confirmSelection,
    onQuotePress,
    confirmRemove,
    dismissRemove,
  };
}

/** Compose the promoted-quote state with its read-mode selection gestures. */
function useQuotePromotion(routeEntryId: number | null): QuotePromotion {
  const { quotes, hint, promote, removePromotion, promoting, promoted, retryPromote, refresh } =
    usePromotions({ entryId: routeEntryId ?? 0 });
  const interaction = useQuoteInteraction(promote, removePromotion);
  // Composed here rather than in the action row, so the flag outlives the row
  // unmounting while the reader is selecting.
  const explainer = usePromoteExplainer(interaction.startSelecting);
  return { quotes, hint, promoting, promoted, retryPromote, refresh, ...interaction, explainer };
}

/**
 * The reading view's resonance affordance, threaded as one value so the row and
 * the column that hosts it stay short-signatured.
 */
interface ReadResonanceAction {
  visible: boolean;
  disabled: boolean;
  loading: boolean;
  checking: boolean;
  /** Why resonance is withheld, shown only while it is disabled. */
  reason: string;
  onPress: () => Promise<void>;
}

interface ReadControlsProps {
  quote: QuotePromotion;
  resonance: ReadResonanceAction;
  onEdit: () => void;
}

/**
 * The reading view's action row, closing the reading column. One layout system
 * for all three controls: resonance as the primary, Promote and Edit beside it
 * as quiet tertiaries.
 */
function ReadActions({ quote, resonance, onEdit }: ReadControlsProps): React.JSX.Element {
  return (
    <View style={styles.readActionsRow} testID="journal-read-actions">
      <GetResonanceButton
        layout="inline"
        visible={resonance.visible}
        loading={resonance.loading}
        checking={resonance.checking}
        disabled={resonance.disabled}
        onPress={resonance.onPress}
      />
      <Button
        variant="tertiary"
        onPress={quote.explainer.onPress}
        accessibilityLabel="Promote a quote"
        testID="promote-quote-button"
        label="Promote a quote"
        busy={quote.promoting}
      />
      <Button
        variant="tertiary"
        onPress={onEdit}
        accessibilityLabel="Edit this entry"
        testID="journal-edit-button"
        label="Edit"
      />
    </View>
  );
}

/**
 * Read-mode affordances: the privacy reason (when resonance is withheld) above
 * the single action row, and the note the first "Promote a quote" opens — kept
 * beside the button that opens it (its state lives in ``useQuotePromotion``,
 * so the row unmounting while the reader selects loses nothing). Unlike the
 * writing surface's floating button, nothing here fades on idleness — a reader
 * is not typing, so nothing needs to get out of the way.
 */
function ReadModeControls(props: ReadControlsProps): React.JSX.Element {
  const { resonance, quote } = props;
  const { explainer } = quote;
  return (
    <>
      <PrivacyResonanceReason
        visible={resonance.visible && resonance.disabled}
        reason={resonance.reason}
      />
      <ReadActions {...props} />
      <PromoteExplainerDialog
        visible={explainer.visible}
        dontShowAgain={explainer.dontShowAgain}
        onToggleDontShowAgain={explainer.onToggleDontShowAgain}
        onContinue={explainer.onContinue}
        onCancel={explainer.onCancel}
      />
    </>
  );
}

/** Copy for the promote-lifecycle notices (real ellipsis inside the in-flight line). */
const PROMOTING_COPY = 'Promoting…';

/**
 * Transient success confirmation that settles in (motion-safe via useEntrance)
 * and names where the quote went. A polite live region announces it on Android
 * and the web; VoiceOver ignores live regions, so iOS is told explicitly.
 */
function PromotedNotice(): React.JSX.Element {
  const settle = useEntrance();
  useEffect(() => announceOnIos(PROMOTED_NOTICE_COPY), []);
  return (
    <Animated.Text
      style={[styles.promotionSuccess, settle]}
      testID="quote-promotion-success"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      {PROMOTED_NOTICE_COPY}
    </Animated.Text>
  );
}

/** The failed-promote notice: a legible error line plus a same-anchors retry. */
function PromotionErrorNotice({ quote }: { quote: QuotePromotion }): React.JSX.Element {
  const retry = quote.retryPromote;
  return (
    <>
      <Text style={styles.promotionErrorText} testID="quote-promotion-error">
        {quote.hint}
      </Text>
      {retry != null ? (
        <Button
          variant="tertiary"
          label="Try again"
          accessibilityLabel="Try again"
          testID="quote-promotion-retry"
          onPress={() => void retry()}
        />
      ) : null}
    </>
  );
}

/**
 * In-flight / error / success feedback for the promote lifecycle, under the body.
 * An error (``hint``) outranks a lingering success notice so a failed remove that
 * lands while a prior "Promoted" confirmation is still up reads honestly.
 */
function QuotePromotionFeedback({ quote }: { quote: QuotePromotion }): React.JSX.Element | null {
  if (quote.promoting) {
    return (
      <Text style={styles.promotionInflight} testID="quote-promotion-inflight">
        {PROMOTING_COPY}
      </Text>
    );
  }
  if (quote.hint != null) return <PromotionErrorNotice quote={quote} />;
  if (quote.promoted) return <PromotedNotice />;
  return null;
}

/** The read-mode passage tree: highlighted body plus the promote-lifecycle notice. */
function ReadBodyContent({
  body,
  notes,
  quote,
  onOpen,
}: {
  body: string;
  notes: Marginalia[];
  quote: QuotePromotion;
  onOpen: (_note: Marginalia) => void;
}): React.JSX.Element {
  return (
    <>
      <HighlightedBody
        body={body}
        notes={notes}
        onOpen={onOpen}
        quotes={quote.quotes}
        onQuotePress={quote.onQuotePress}
        removeTargetId={quote.removeTargetId}
        onConfirmRemove={quote.confirmRemove}
        onDismissRemove={quote.dismissRemove}
      />
      <QuotePromotionFeedback quote={quote} />
    </>
  );
}

/** Read-mode body: the title + the highlighted passage tree + the action row. */
function ReadColumn({
  title,
  body,
  notes,
  quote,
  resonance,
  justSaved,
  onOpen,
  onEdit,
}: {
  title: string;
  body: string;
  notes: Marginalia[];
  quote: QuotePromotion;
  resonance: ReadResonanceAction;
  /** True when this entry was just saved from photograph capture; shows "Saved". */
  justSaved: boolean;
  onOpen: (_note: Marginalia) => void;
  onEdit: () => void;
}) {
  return (
    <View style={[styles.writingColumn, readingScrollStyle]}>
      <View style={styles.writingColumnContent}>
        {title ? <Text style={styles.titleInput}>{title}</Text> : null}
        <View style={styles.hairline} />
        {quote.selecting ? (
          <QuoteSelectionSurface
            body={body}
            onSelectionChange={quote.onSelectionChange}
            onConfirm={quote.confirmSelection}
            onCancel={quote.cancelSelecting}
          />
        ) : (
          <ReadBodyContent body={body} notes={notes} quote={quote} onOpen={onOpen} />
        )}
        <Text style={styles.savedHint} testID="journal-save-hint">
          {justSaved ? SAVED_HINT : BLANK_HINT}
        </Text>
        {quote.selecting ? null : (
          <ReadModeControls quote={quote} resonance={resonance} onEdit={onEdit} />
        )}
      </View>
    </View>
  );
}

type MarginItem =
  | { key: string; anchor: number; note: Marginalia }
  | { key: string; anchor: number; suggestion: CompletionSuggestion };

/** Literary notes + actionable suggestions interleaved by anchor position. */
interface MarginStreamProps {
  notes: Marginalia[];
  suggestions: CompletionSuggestion[];
  acceptedCheckIns: Record<number, CheckInResult | null>;
  /** The signed-in person's zone -- the clock the facts line is named against. */
  userTimezone: string;
  onOpen: (_note: Marginalia) => void;
  onAccept: (_id: number) => void | Promise<void>;
  onDismiss: (_id: number) => void | Promise<void>;
}

function buildMarginItems(notes: Marginalia[], suggestions: CompletionSuggestion[]): MarginItem[] {
  const items: MarginItem[] = [
    ...notes.map((note) => ({ key: `note-${note.id}`, anchor: note.anchor_start, note })),
    ...suggestions
      .filter((s) => s.status !== 'dismissed')
      .map((s) => ({ key: `suggestion-${s.id}`, anchor: s.anchor_start, suggestion: s })),
  ];
  return items.sort((a, b) => a.anchor - b.anchor);
}

/**
 * One offer card, joined to the two things it cannot read for itself.
 *
 * The card is presentational on purpose -- no auth, no store, no clock -- so
 * the join lives here: the goal's unit comes from the habit store by
 * `goal_id`, refusing any row this device minted, and "today" comes from the
 * signed-in person's own zone rather than the device's, so a card pinned over
 * midnight re-renders from "yesterday" to a date instead of quietly lying.
 */
function ConnectedSuggestionNote({
  suggestion,
  checkIn,
  userTimezone,
  onAccept,
  onDismiss,
}: {
  suggestion: CompletionSuggestion;
  checkIn: CheckInResult | null;
  userTimezone: string;
  onAccept: (_id: number) => void | Promise<void>;
  onDismiss: (_id: number) => void | Promise<void>;
}) {
  const unit = useHabitStore(selectGoalUnitById(suggestion.goal_id));
  const todayIso = useDayKey(userTimezone);
  return (
    <CompletionSuggestionNote
      suggestion={suggestion}
      checkIn={checkIn}
      facts={describeSuggestionFacts(suggestion, unit, todayIso)}
      onAccept={onAccept}
      onDismiss={onDismiss}
    />
  );
}

function MarginStream({
  notes,
  suggestions,
  acceptedCheckIns,
  userTimezone,
  onOpen,
  onAccept,
  onDismiss,
}: MarginStreamProps) {
  return (
    <>
      {buildMarginItems(notes, suggestions).map((item) => (
        <View key={item.key} style={styles.marginNoteSlot}>
          {'note' in item ? (
            <MarginNote note={item.note} onOpen={onOpen} />
          ) : (
            <ConnectedSuggestionNote
              suggestion={item.suggestion}
              checkIn={acceptedCheckIns[item.suggestion.id] ?? null}
              userTimezone={userTimezone}
              onAccept={onAccept}
              onDismiss={onDismiss}
            />
          )}
        </View>
      ))}
    </>
  );
}

type ScreenNavigation = JournalEntryScreenProps['navigation'];

/** The essay-modal open/close state + essay caching. */
function useEssayModal(updateNote: (_note: Marginalia) => void) {
  const [openNote, setOpenNote] = useState<Marginalia | null>(null);
  const onOpenNote = useCallback((note: Marginalia) => setOpenNote(note), []);
  const onCloseNote = useCallback(() => setOpenNote(null), []);
  // Cache the freshly-loaded essay back onto the note and keep the modal current.
  const onEssayLoaded = useCallback(
    (updated: Marginalia) => {
      updateNote(updated);
      setOpenNote(updated);
    },
    [updateNote],
  );
  return { openNote, onOpenNote, onCloseNote, onEssayLoaded };
}

interface EditGateArgs {
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  finish: () => Promise<number>;
  body: string;
  navigation: ScreenNavigation;
  onConfirmEdit: () => void;
}

/** The deliberate edit gate for finished entries + the draft "Finish" action. */
function useEditGate({ status, setStatus, finish, body, navigation, onConfirmEdit }: EditGateArgs) {
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  // A finished entry is read-only until the user deliberately chooses to edit.
  const editMode = editing || status !== 'finished';

  const requestEdit = useCallback(() => setConfirmOpen(true), []);
  const cancelEdit = useCallback(() => setConfirmOpen(false), []);
  const confirmEdit = useCallback(() => {
    setConfirmOpen(false);
    setEditing(true);
    onConfirmEdit();
  }, [onConfirmEdit]);
  const startNew = useCallback(() => {
    setConfirmOpen(false);
    navigation.push('JournalEntry');
  }, [navigation]);
  // Only flip to finished once the single atomic write resolves; on failure the
  // entry stays a draft (editable) and the error invites a retry.
  const markFinished = useCallback(async () => {
    setFinishError(null);
    setFinishing(true);
    try {
      await finish();
      setStatus('finished');
      setEditing(false);
    } catch {
      setFinishError(FINISH_ERROR_MESSAGE);
    } finally {
      setFinishing(false);
    }
  }, [finish, setStatus]);

  const canFinish = status === 'draft' && body.trim().length > 0;
  return {
    editMode,
    confirmOpen,
    requestEdit,
    cancelEdit,
    confirmEdit,
    startNew,
    markFinished,
    canFinish,
    finishing,
    finishError,
  };
}

/**
 * The screen's idle gate, with one addition: a page that opens onto writing
 * that already exists counts as settled the moment its text arrives.
 *
 * ``isIdle`` models "the writer has paused *after writing*", which on a fresh
 * page is exactly right. On an entry saved days ago there is no writing to
 * pause after, so the pause never arrives and the reading is never offered —
 * the writer sees a page with no affordance on it at all, which is what was
 * reported. Nothing here loosens the pause for a page being composed: this
 * fires once, only for an entry whose own text came back from the server with
 * something in it, and any keystroke afterwards bumps the ordinary timer back
 * into charge.
 */
function useResonanceIdle(autosave: AutosaveApi): { isIdle: boolean; bump: () => void } {
  const { isIdle, bump, settle } = useIdle();
  const settledRef = useRef(false);
  const hasContent = autosave.body.trim().length > 0;
  useEffect(() => {
    if (settledRef.current || !autosave.loadedFromServer || !hasContent) return;
    settledRef.current = true;
    settle();
  }, [autosave.loadedFromServer, hasContent, settle]);
  return { isIdle, bump };
}

/** Wrap the autosave change handlers so each keystroke also bumps the idle timer. */
function useBumpedHandlers(bump: () => void, autosave: AutosaveApi) {
  const { onChangeTitle, onChangeBody } = autosave;
  const handleTitle = useCallback(
    (t: string) => {
      bump();
      onChangeTitle(t);
    },
    [bump, onChangeTitle],
  );
  const handleBody = useCallback(
    (t: string) => {
      bump();
      onChangeBody(t);
    },
    [bump, onChangeBody],
  );
  return { handleTitle, handleBody };
}

interface ResonanceGate {
  /** Whether the resonance affordance is shown at all (hidden in prompt-compose). */
  visible: boolean;
  /** Shown-but-disabled: an intimate entry is never sent to AI. */
  resonanceDisabled: boolean;
  /** One-line reason accompanying a disabled/withheld resonance affordance. */
  resonanceReason: string;
}

interface ResonanceGateArgs {
  isIdle: boolean;
  isLoading: boolean;
  body: string;
  classification: JournalClassification;
  isPromptCompose: boolean;
  privateMessage: string | null;
}

/** Derive whether/how the resonance affordance shows, incl. the intimate gate. */
function deriveResonanceGate(args: ResonanceGateArgs): ResonanceGate {
  const hasContent = args.body.trim().length > 0;
  // In weekly-prompt compose mode the entry is created by prompts.respond, which
  // doesn't return a local id — so resonance can't run here. Hide the button; the
  // reflection gains resonance normally once reopened from the shelf (with an id).
  const visible =
    !args.isPromptCompose &&
    shouldShowResonance({ isIdle: args.isIdle, hasContent, isLoading: args.isLoading });
  return {
    visible,
    // Client-side privacy gate: an intimate entry is never sent to AI, so the
    // resonance affordance is shown-but-disabled with a visible reason.
    resonanceDisabled: args.classification === 'intimate',
    resonanceReason: args.privateMessage ?? INTIMATE_RESONANCE_REASON,
  };
}

/** Compose the autosave + idle + resonance hooks into the screen's view-model. */
/**
 * The live review claiming ``scopeKey``, or null. Every scope that can be
 * composed — the due one, and any begun early from the picker — is in progress
 * today, so ``/reflections/current`` is asked first; ``/reflections/due`` is
 * the fallback should that read fail.
 */
async function liveReviewFor(scopeKey: string): Promise<number | null> {
  const { scopes } = await reflections.current().catch(() => ({ scopes: [] }));
  const open = scopes.find((scope) => scope.scope_key === scopeKey);
  if (open?.existing_entry_id != null) return open.existing_entry_id;
  const { due } = await reflections.due();
  return due != null && due.scope_key === scopeKey ? due.existing_entry_id : null;
}

/**
 * A reflection-scope create can 409 because the reflection already exists —
 * begun in another tab, or from a picker row read before it was claimed.
 * Find the live review for the same scope and route there instead of leaving
 * a dead-ended save error that no retry could ever clear.
 */
function useCreateConflictHandler(ctx: SaveContext, navigation: ScreenNavigation): () => void {
  return useCallback(() => {
    const scopeKey = ctx.reflectionScopeKey;
    if (scopeKey == null) return;
    void liveReviewFor(scopeKey)
      .then((entryId) => {
        if (entryId != null) navigation.replace('JournalEntry', { entryId });
      })
      .catch(() => {
        // Fall back to the plain save-error hint; the draft is safe and retryable.
      });
  }, [ctx.reflectionScopeKey, navigation]);
}

/**
 * Wire the reflection composer: mirror the latest body onto a ref so a folded
 * quote can be spliced at the caret without threading the autosave's draft ref
 * out, and hand the sources/insert flow the body writer + flush.
 */
function useReflectionComposer(autosave: AutosaveApi) {
  const reflectionBodyRef = useRef(autosave.body);
  reflectionBodyRef.current = autosave.body;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const openSources = useCallback(() => setSourcesOpen(true), []);
  const closeSources = useCallback(() => setSourcesOpen(false), []);
  // Closing hands focus back to the toggle that opened the panel (#2883); the
  // draft is untouched, since it lives in the autosave, not in this flag.
  const sourcesToggleRef: SourcesToggleRef = useRef(null);
  useRestoreFocusOnClose(sourcesOpen, sourcesToggleRef);
  const sourcesToggle = useMemo<SourcesToggle>(
    () => ({ onOpen: openSources, ref: sourcesToggleRef }),
    [openSources],
  );
  const mode = useReflectionMode({
    reflectionLevel: autosave.reflectionLevel,
    reflectionScopeKey: autosave.reflectionScopeKey,
    bodyRef: reflectionBodyRef,
    onChangeBody: autosave.onChangeBody,
    // Durable-only: a fold marks quotes included on the saved review, so a
    // failed body write must leave them pending (and retryable), never marked.
    flush: autosave.flushDurable,
  });
  return { ...mode, sourcesOpen, sourcesToggle, closeSources };
}

/** What the writing surface needs to send the writer off to photograph a page. */
interface PhotographedPage {
  /** Opens the shared capture route in append mode, addressed to this page. */
  openCapture: () => void;
}

/**
 * The photographed-page seam: send the writer to the existing capture route,
 * and fold the transcript it hands back into THIS page.
 *
 * The transcript arrives through {@link useCapturedTranscriptStore} rather than
 * navigation params, and lands via ``onChangeBody`` — the same seam a folded-in
 * quote uses — so the ordinary create-then-update writer persists it under the
 * title and save context this page already carries. That is what makes a
 * photographed Course reflection one entry rather than two, and it is why the
 * capture route needs no entry id: a reflection photographed before a word is
 * typed does not have one yet.
 *
 * The hand-off is addressed. More than one entry page can be mounted at once
 * (``startNew`` pushes a second), and all of them watch this store, so a page
 * collects only the delivery bearing the token it minted — never a sibling's.
 */
function usePhotographedPage(
  navigation: ScreenNavigation,
  body: string,
  onChangeBody: (_next: string) => void,
): PhotographedPage {
  const pending = useCapturedTranscriptStore((store) => store.pending);
  const openHandoff = useCapturedTranscriptStore((store) => store.open);
  const clear = useCapturedTranscriptStore((store) => store.clear);
  // The body is read at collection time, not at subscribe time: the writer may
  // have typed on for a while before the transcript came back.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const tokenRef = useRef<string | null>(null);

  const openCapture = useCallback(() => {
    tokenRef.current = openHandoff();
    navigation.navigate('JournalPhotograph', { appendTo: tokenRef.current });
  }, [navigation, openHandoff]);

  useEffect(() => {
    if (pending == null || pending.token !== tokenRef.current) return;
    // Retract first: collecting is a one-shot, and clearing before the write
    // means a re-render mid-append cannot fold the same page in twice.
    clear();
    onChangeBody(appendTranscript(bodyRef.current, pending.text));
  }, [pending, clear, onChangeBody]);

  return { openCapture };
}

/**
 * The writing surface's own seams, grouped because all three write the SAME body
 * through the same handler: the idle-bumped field writers, the reflection
 * composer that splices a quote at the caret, and the photographed-page hand-off
 * that appends a transcript. Anything that folds text into the page belongs here
 * rather than scattered across the controller.
 */
function useWritingSeams(navigation: ScreenNavigation, autosave: AutosaveApi, bump: () => void) {
  const { handleTitle, handleBody } = useBumpedHandlers(bump, autosave);
  const reflection = useReflectionComposer(autosave);
  const photograph = usePhotographedPage(navigation, autosave.body, handleBody);
  return { handleTitle, handleBody, reflection, photograph };
}

/**
 * The save-recovery seam (#2930): the footer's Retry and the reconnect retry
 * re-send every failed write through its ordinary writer, and Finish through
 * the edit gate so the status flips and the Finish error clears.
 */
function useEntrySaveRetry(autosave: AutosaveApi, retryFinish: () => Promise<void>): SaveRetry {
  const source = autosave.retrySource;
  const retry = useSaveRetry({
    ledger: source.ledger,
    displayedTier: source.displayedTier,
    retryFinish,
    retryBody: source.retryBody,
    applyClassification: source.applyClassification,
    applyChord: source.applyChord,
  });
  useReconnectRetry({ hint: autosave.saveState, isWriteInFlight: source.isWriteInFlight, retry });
  return retry;
}

/**
 * Put words held by a load back on the page once editing is allowed (#2935).
 *
 * A draft is always editable, so they go straight back. A finished entry is
 * read-only until the writer deliberately chooses Edit, so its held words are
 * never written around that choice: the edit-confirm dialog is offered once,
 * saying the words are waiting, and they return (and save) only after Edit,
 * which also runs the edit's anchor refreshers. Cancel leaves them held, and
 * the read view's own Edit offers them again.
 */
function useReleaseCarryWhenEditable(
  autosave: Pick<AutosaveApi, 'carryHeld' | 'releaseCarry'>,
  gate: { editMode: boolean; requestEdit: () => void },
): void {
  const offeredRef = useRef(false);
  const { carryHeld, releaseCarry } = autosave;
  const { editMode, requestEdit } = gate;
  useEffect(() => {
    if (!carryHeld) return;
    if (editMode) {
      void releaseCarry();
      return;
    }
    if (offeredRef.current) return;
    offeredRef.current = true;
    requestEdit();
  }, [carryHeld, editMode, releaseCarry, requestEdit]);
}

/** The finished-entry edit gate wired from the autosave's status + finish write. */
function useEntryEditGate(
  autosave: AutosaveApi,
  navigation: ScreenNavigation,
  onConfirmEdit: () => void,
) {
  const gate = useEditGate({
    status: autosave.status,
    setStatus: autosave.setStatus,
    finish: autosave.finish,
    body: autosave.body,
    navigation,
    onConfirmEdit,
  });
  useReleaseCarryWhenEditable(autosave, gate);
  return { ...gate, carriedWords: autosave.carryHeld };
}

/**
 * ``useResonance``, bound to the signed-in person's own day boundary.
 *
 * The zone comes from auth rather than the device because accepting a
 * completion suggestion refreshes the habit store, which buckets "today" by
 * it -- a late-night check-off would otherwise land on the wrong day. Given its
 * own hook so the controller reads one line here, as it does at every other seam.
 */
function useEntryResonance(routeEntryId: number | null, flush: () => Promise<number | null>) {
  const { userTimezone } = useAuth();
  // The zone is handed back as well as in: the margin's offer cards name the
  // day their accept will log against, and that has to be the same clock this
  // seam buckets by. Returned from the one read rather than taken from a
  // second `useAuth()` further down the tree.
  return { resonance: useResonance({ routeEntryId, flush, userTimezone }), userTimezone };
}

/** Everything the entry screen needs at the resonance seam, in one place. */
interface ResonanceSeamInput {
  routeEntryId: number | null;
  autosave: AutosaveApi;
  ctx: SaveContext;
  isIdle: boolean;
  justSaved: boolean;
}

/**
 * The resonance seam: the one charged pass, the spend disclosure in front of it,
 * and the rules for when the affordance is offered at all.
 *
 * Grouped rather than left inline because the three are one decision. The pass
 * costs a BotMason message, so the button must press the gate and never the
 * pass — and a later reader wiring a third resonance affordance should find the
 * gate here rather than have to notice it among the controller's other seams.
 */
function useResonanceSeam({ routeEntryId, autosave, ctx, isIdle, justSaved }: ResonanceSeamInput) {
  const { resonance, userTimezone } = useEntryResonance(routeEntryId, autosave.flush);
  const explainer = useResonanceExplainer(resonance.requestResonance);
  const gate = deriveResonanceGate({
    // A photograph-capture handoff (justSaved) offers resonance immediately,
    // without waiting for the usual post-typing idle pause.
    isIdle: isIdle || justSaved,
    isLoading: resonance.loading || explainer.pending,
    body: autosave.body,
    classification: autosave.classification,
    isPromptCompose: ctx.weekNumber != null,
    privateMessage: resonance.privateMessage,
  });
  return { resonance, userTimezone, explainer, gate };
}

function useJournalEntryController(
  routeEntryId: number | null,
  autosaveDelayMs: number,
  navigation: ScreenNavigation,
  ctx: SaveContext,
  initialText: InitialText,
  justSaved: boolean,
  initialClassification: JournalClassification,
) {
  const { refreshersRef, handleSaved, onConfirmEdit } = useRefreshAfterEdit();
  const onCreateConflict = useCreateConflictHandler(ctx, navigation);
  const autosave = useJournalAutosave(
    routeEntryId,
    autosaveDelayMs,
    ctx,
    initialText,
    initialClassification,
    handleSaved,
    onCreateConflict,
  );
  const { isIdle, bump } = useResonanceIdle(autosave);
  const { resonance, userTimezone, explainer, gate } = useResonanceSeam({
    routeEntryId,
    autosave,
    ctx,
    isIdle,
    justSaved,
  });
  const quote = useQuotePromotion(autosave.entryId);
  // The first save after an edit re-anchors notes AND pending quotes server-side.
  refreshersRef.current = [resonance.refresh, quote.refresh];
  const modal = useEssayModal(resonance.updateNote);
  const editGate = useEntryEditGate(autosave, navigation, onConfirmEdit);
  const saveRetry = useEntrySaveRetry(autosave, editGate.markFinished);
  const writing = useWritingSeams(navigation, autosave, bump);

  return {
    autosave,
    resonance,
    userTimezone,
    explainer,
    quote,
    ...gate,
    // handleTitle/handleBody, the reflection composer and the photographed-page
    // hand-off — everything that writes the body — arrive together.
    ...writing,
    modal,
    editGate,
    saveRetry,
    justSaved,
    // Weekly-prompt compose withholds Finish (no local id); title stays editable.
    isPromptCompose: ctx.weekNumber != null,
  };
}

type Controller = ReturnType<typeof useJournalEntryController>;

/**
 * The reading view's resonance action. Steady where the writing surface's is
 * idle-gated: reading involves no keystrokes, so there is no pause to detect and
 * nothing to tuck away. Only an empty page (nothing to read back) or the privacy
 * gate takes it out of reach.
 */
function buildReadResonanceAction(ctl: Controller): ReadResonanceAction {
  return {
    visible: !ctl.isPromptCompose && ctl.autosave.body.trim().length > 0,
    disabled: ctl.resonanceDisabled,
    loading: ctl.resonance.loading,
    checking: ctl.explainer.pending,
    reason: ctl.resonanceReason,
    onPress: ctl.explainer.onPress,
  };
}

/** The body column: the editable writing surface, or the read-mode highlighted view. */
/**
 * The footer's Retry and held state. Retry re-sends the held words' tier while
 * they wait on one (#2935), else whatever failed to save (#2930).
 */
function saveFooterFor(ctl: Controller): SaveFooterActions {
  const held = heldFooterFor(ctl.autosave);
  if (ctl.autosave.carryWaitingTier != null) {
    return { retry: ctl.autosave.resendCarryTier, held };
  }
  return { retry: () => ctl.saveRetry.retryFailedSave('tap'), held };
}

function PageBodyColumn({
  ctl,
  bodyPlaceholder,
  compactControls,
}: {
  ctl: Controller;
  bodyPlaceholder: string;
  compactControls: boolean;
}) {
  const { title, body, saveState, classification, chord } = ctl.autosave;
  const { editMode, canFinish, markFinished, requestEdit } = ctl.editGate;
  const controlsDisabled = ctl.autosave.controlsLocked;
  const canOfferFinish = canFinish && !ctl.isPromptCompose;
  return editMode ? (
    <WritingColumn
      title={title}
      body={body}
      saveState={hintStateWhileFolding(saveState, ctl.reflection.foldingIn)}
      classification={classification}
      chord={chord}
      onChangeTitle={ctl.handleTitle}
      onChangeBody={ctl.handleBody}
      onChangeClassification={ctl.autosave.onChangeClassification}
      onChangeChord={ctl.autosave.onChangeChord}
      onRetrySave={saveFooterFor(ctl)}
      onFinish={canOfferFinish ? markFinished : undefined}
      finishing={ctl.editGate.finishing}
      finishError={ctl.editGate.finishError}
      bodyPlaceholder={bodyPlaceholder}
      controlsDisabled={controlsDisabled}
      onBodySelectionChange={
        ctl.reflection.active ? ctl.reflection.onBodySelectionChange : undefined
      }
      sources={ctl.reflection.active ? ctl.reflection.sourcesToggle : undefined}
      compactControls={compactControls}
    />
  ) : (
    <ReadColumn
      title={title}
      body={body}
      notes={ctl.resonance.marginalia}
      quote={ctl.quote}
      resonance={buildReadResonanceAction(ctl)}
      justSaved={ctl.justSaved && !ctl.autosave.carryHeld}
      onOpen={ctl.modal.onOpenNote}
      onEdit={requestEdit}
    />
  );
}

/** Build the margin's note/suggestion stream without making the page own its branches. */
function JournalMargin({ ctl, narrow }: { ctl: Controller; narrow: boolean }) {
  const notes = ctl.resonance.marginalia;
  const suggestions = ctl.resonance.suggestions;
  const hasVisibleSuggestions = suggestions.some((s) => s.status !== 'dismissed');
  return (
    <View
      style={[styles.marginColumn, narrow && styles.marginColumnNarrow]}
      testID="journal-margin-column"
    >
      <NoNotesNotice message={ctl.resonance.noNotesMessage} />
      <ResonanceMargin error={ctl.resonance.error} />
      {notes.length > 0 || hasVisibleSuggestions ? (
        <MarginStream
          notes={notes}
          suggestions={suggestions}
          acceptedCheckIns={ctl.resonance.acceptedCheckIns}
          userTimezone={ctl.userTimezone}
          onOpen={ctl.modal.onOpenNote}
          onAccept={ctl.resonance.acceptSuggestion}
          onDismiss={ctl.resonance.dismissSuggestion}
        />
      ) : null}
      {ctl.editGate.editMode && !narrow ? (
        <ResonanceControls
          layout="margin"
          visible={ctl.visible}
          disabled={ctl.resonanceDisabled}
          loading={ctl.resonance.loading}
          checking={ctl.explainer.pending}
          reason={ctl.resonanceReason}
          onPress={ctl.explainer.onPress}
        />
      ) : null}
    </View>
  );
}

/** The paper page inside the scroller: the body column and its margin. */
function JournalPageSurface({
  ctl,
  bodyPlaceholder,
  narrow,
  compactControls,
  focus,
}: {
  ctl: Controller;
  bodyPlaceholder: string;
  narrow: boolean;
  compactControls: boolean;
  focus: FocusScrollHost;
}): React.JSX.Element {
  return (
    <View
      ref={focus.pageRef}
      onLayout={focus.onPageLayout}
      style={[
        styles.page,
        narrow && styles.pageNarrow,
        ctl.editGate.editMode && styles.pageWithFloatingAction,
      ]}
      testID="journal-page"
    >
      <FocusScrollProvider value={focus.value}>
        <PageBodyColumn
          ctl={ctl}
          bodyPlaceholder={bodyPlaceholder}
          compactControls={compactControls}
        />
      </FocusScrollProvider>
      <JournalMargin ctl={ctl} narrow={narrow} />
    </View>
  );
}

function JournalPage({
  ctl,
  bodyPlaceholder,
  focusSpan,
}: {
  ctl: Controller;
  bodyPlaceholder: string;
  /** A quote the reader arrived to see; read mode scrolls it into view. */
  focusSpan?: FocusSpan;
}) {
  const viewportWidth = useWindowDimensions().width;
  const narrow = viewportWidth < NARROW_BREAKPOINT;
  const compactControls = viewportWidth < COMPACT_WRITING_CONTROLS_BREAKPOINT;
  const settle = useEntrance();
  const focus = useFocusScrollHost(focusSpan);
  return (
    <View style={styles.desk}>
      <Animated.View
        style={[styles.sheet, narrow && styles.sheetNarrow, settle]}
        testID="journal-sheet"
      >
        <ScrollView
          ref={focus.scrollRef}
          style={styles.pageScroll}
          contentContainerStyle={styles.pageScrollContent}
          keyboardShouldPersistTaps="handled"
          testID="journal-page-scroll"
        >
          <JournalPageSurface
            ctl={ctl}
            bodyPlaceholder={bodyPlaceholder}
            narrow={narrow}
            compactControls={compactControls}
            focus={focus}
          />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

interface EntryEntrypoint {
  ctx: SaveContext;
  initialText: InitialText;
  bodyPlaceholder: string;
  /** The tier a fresh entry opens at (from the capture flow's intimate offramp);
   *  ``personal`` when the route carries no classification. */
  initialClassification: JournalClassification;
}

/** Translate the route params into the save context + pre-filled title/body/placeholder. */
function readEntrypoint(params: RootStackParamList['JournalEntry']): EntryEntrypoint {
  const p = params ?? {};
  // No client-side fallback title: a prompt's name is curriculum text the server
  // owns and sends, so an untitled arrival opens blank rather than under a label
  // the client guessed from the week number.
  const title = p.prefillTitle ?? '';
  // A folded-in quote seeds the body as a blockquote; otherwise the body opens blank.
  const body =
    p.prefillQuote != null
      ? formatQuotePrefill(p.prefillQuote.text, p.prefillQuote.sourceTitle)
      : '';
  return {
    ctx: {
      weekNumber: p.weekNumber,
      promptOrdinal: p.promptOrdinal,
      practiceSessionId: p.practiceSessionId,
      userPracticeId: p.userPracticeId,
      reflectionLevel: p.reflectionLevel,
      reflectionScopeKey: p.reflectionScopeKey,
    },
    initialText: { title, body },
    bodyPlaceholder: p.promptQuestion ?? DEFAULT_BODY_PLACEHOLDER,
    initialClassification: p.classification ?? DEFAULT_TIER,
  };
}

/**
 * The one-line reason shown when resonance is gated off for an intimate entry.
 * Always a sibling directly above the affordance it explains — the floating
 * button while writing, the action row while reading — so it reads as that
 * control's own caption rather than as a stray notice.
 */
function PrivacyResonanceReason({
  visible,
  reason,
}: {
  visible: boolean;
  reason: string;
}): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Text style={styles.privacyResonanceReason} testID="privacy-resonance-reason">
      {reason}
    </Text>
  );
}

/**
 * Warm inline notice shown when an existing entry fails to load. A sibling above
 * the page (never a margin note) so it reads as the page's own — and its promise
 * that writing is safe is kept true by the autosave gate in ``useDebouncedSave``.
 */
function LoadErrorBanner({ message }: { message: string | null }): React.JSX.Element | null {
  if (message == null) return null;
  return (
    <View style={styles.loadErrorBanner}>
      <Text style={styles.loadErrorText} testID="journal-load-error">
        {message}
      </Text>
    </View>
  );
}

/** What the page says while carried words wait on a stricter tier (#2935). */
export function carryWaitingCopy(tier: JournalClassification): string {
  return `The words you wrote while this page couldn’t open are waiting here, not yet saved. They’ll come back once this entry is saved as ${tierLabel(tier)} or more private — tap Retry, or choose that setting.`;
}

/** Say that carried words are waiting on a stricter tier, until they come back. */
function CarryWaitingNote({
  tier,
}: {
  tier: JournalClassification | null;
}): React.JSX.Element | null {
  if (tier == null) return null;
  return (
    <View style={styles.loadErrorBanner}>
      <Text style={styles.carryWaitingText} testID="journal-carry-waiting">
        {carryWaitingCopy(tier)}
      </Text>
    </View>
  );
}

/** The page's standing notices: a failed load, and words waiting on a tier. */
function EntryNotices({
  autosave,
}: {
  autosave: Pick<AutosaveApi, 'loadError' | 'carryWaitingTier'>;
}): React.JSX.Element {
  return (
    <>
      <LoadErrorBanner message={autosave.loadError} />
      <CarryWaitingNote tier={autosave.carryWaitingTier} />
    </>
  );
}

/** The reader location "Back to reading" returns to, carrying the scroll offset. */
type CourseReturnTo = NonNullable<RootStackParamList['JournalEntry']>['returnTo'];

/**
 * "Back to reading" affordance shown only when the writer arrived from the course
 * reader (``returnTo`` present). Pressing it flushes any typed draft — kicking the
 * save in flight and cancelling the debounce timer so nothing is lost as this
 * stack screen unmounts — then returns to the exact Course content they left. The
 * flush is fired, not awaited, so the return navigation happens immediately while
 * the persist completes independently of this screen's lifecycle.
 */
function ReturnToReadingLink({
  returnTo,
  navigation,
  flush,
  guard,
}: {
  returnTo: CourseReturnTo;
  navigation: ScreenNavigation;
  flush: () => Promise<number | null>;
  guard: Pick<HeldExitGuard, 'held' | 'request'>;
}): React.JSX.Element | null {
  const { held, request } = guard;
  const onPress = useCallback(() => {
    if (returnTo == null) return;
    const back = () =>
      navigation.navigate('Tabs', { screen: returnTo.screen, params: returnTo.params });
    // While words are held nothing can be flushed; the guard asks before leaving.
    if (held) {
      request(back);
      return;
    }
    void flush();
    back();
  }, [returnTo, navigation, flush, held, request]);
  if (returnTo == null) return null;
  return (
    <TouchableOpacity
      style={styles.quoteActionButton}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Back to reading — return to where you were reading"
      testID="journal-return-to-reading"
    >
      <Text style={styles.controlLink}>Back to reading</Text>
    </TouchableOpacity>
  );
}

/** Screen-reader name for the exit that is offered no matter how they arrived. */
const CLOSE_ENTRY_LABEL = 'Close — return to your journal';
const PAYER_SETTINGS_LABEL = 'Add or change your API key';

/** Direct access to the payer setting without discarding or saving over the page. */
function ApiKeySettingsLink({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.entryIconButton}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={PAYER_SETTINGS_LABEL}
      testID="journal-api-key-settings"
    >
      <KeyRound
        color={accent.primary}
        size={NAV_ICON_SIZE}
        strokeWidth={NAV_ICON_STROKE}
        accessible={false}
      />
    </TouchableOpacity>
  );
}

/**
 * The always-available way out of the writing surface. ``ReturnToReadingLink``
 * only appears for a writer who came from the course reader, which left everyone
 * else with no exit the screen itself offered. This one is never gated: it waits
 * for the pending draft to reach storage before the shelf is allowed to reload. A
 * failed final write leaves the writer and the existing retry hint in place,
 * making the X a keep action rather than a race against the shelf.
 */
function CloseEntryLink({
  navigation,
  flush,
  guard,
}: {
  navigation: ScreenNavigation;
  flush: () => Promise<boolean>;
  guard: Pick<HeldExitGuard, 'held' | 'request'>;
}): React.JSX.Element {
  const [closing, setClosing] = useState(false);
  const { held, request } = guard;
  const onPress = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    const toJournal = () => navigation.navigate('Tabs', { screen: 'Journal' });
    // While words are held the flush is never durable, so Close cannot report the
    // page saved; the guard asks instead of closing silently or sticking.
    const durable = await flush();
    setClosing(false);
    if (durable) toJournal();
    else if (held) request(toJournal);
  }, [closing, flush, navigation, held, request]);
  return (
    <TouchableOpacity
      style={styles.entryIconButton}
      onPress={() => void onPress()}
      disabled={closing}
      accessibilityRole="button"
      accessibilityLabel={CLOSE_ENTRY_LABEL}
      accessibilityState={{ busy: closing, disabled: closing }}
      testID="journal-close-entry"
    >
      <X color={accent.primary} size={24} accessible={false} />
    </TouchableOpacity>
  );
}

/** A leave that finishes the stack removal the guard held back. */
function dispatchLeave(
  navigation: ScreenNavigation,
  action: Parameters<ScreenNavigation['dispatch']>[0],
): () => void {
  return () => navigation.dispatch(action);
}

/** A leave the held-exit guard is holding back until the writer chooses. */
type PendingLeave = { run: () => void } | null;

/** The held-exit guard's controls (#2935). */
interface HeldExitGuard {
  /** True while offline words wait to be put back: every exit asks first. */
  held: boolean;
  /** Run ``leave`` now, or, while words are held, ask before running it. */
  request: (_leave: () => void) => void;
  pending: boolean;
  stay: () => void;
  leave: () => void;
}

/**
 * Guard every exit while offline words are held (#2935). The in-page exits
 * (Close, Back to reading) call ``request``; everything that removes this
 * screen from the stack (the back gesture, hardware or browser back, a
 * navigate that pops it) is caught by ``beforeRemove``. Either way the writer
 * is asked, and leaving without the words is only ever their explicit choice.
 * Pushing another screen on top keeps this one, and its held words, mounted,
 * so it is not an exit. Closing the app or browser tab cannot be intercepted.
 */
function useHeldExitGuard(navigation: ScreenNavigation, held: boolean): HeldExitGuard {
  const [pending, setPending] = useState<PendingLeave>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const leavingRef = useRef(false);
  useEffect(
    () =>
      navigation.addListener?.('beforeRemove', (event) => {
        if (!heldRef.current || leavingRef.current) return;
        event.preventDefault();
        setPending({ run: dispatchLeave(navigation, event.data.action) });
      }),
    [navigation],
  );
  const request = useCallback((leave: () => void) => {
    if (heldRef.current) setPending({ run: leave });
    else leave();
  }, []);
  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    leavingRef.current = true;
    setPending(null);
    pending?.run();
  }, [pending]);
  return { held, request, pending: pending != null, stay, leave };
}

/** The exit row plus the dialog its guard asks with (#2935). */
function EntryExits({
  ctl,
  navigation,
  returnTo,
  onOpenApiKey,
}: {
  ctl: Controller;
  navigation: ScreenNavigation;
  returnTo: CourseReturnTo;
  onOpenApiKey: () => void;
}): React.JSX.Element {
  const guard = useHeldExitGuard(navigation, ctl.autosave.carryHeld);
  const { stay } = guard;
  const { resendCarryTier } = ctl.autosave;
  const onRetry = useCallback(() => {
    stay();
    void resendCarryTier();
  }, [stay, resendCarryTier]);
  return (
    <>
      <EntryExitControls
        ctl={ctl}
        returnTo={returnTo}
        navigation={navigation}
        onOpenApiKey={onOpenApiKey}
        guard={guard}
      />
      <HeldWordsLeaveDialog
        visible={guard.pending}
        onStay={stay}
        onLeave={guard.leave}
        onRetry={ctl.autosave.carryRetryReady ? onRetry : undefined}
      />
    </>
  );
}

/**
 * The page's top-right row: the course return when there is one, the API-key
 * door, the camera while writing, and the close always — [Return?][Key][Camera][X].
 * The return and the close are separate affordances — the return carries the
 * reader back to the exact passage they left, which the close cannot know about.
 * The camera shares the writing column's gate (``editMode``): a finished page is
 * read, not added to.
 */
function EntryExitControls({
  ctl,
  returnTo,
  navigation,
  onOpenApiKey,
  guard,
}: {
  ctl: Controller;
  returnTo: CourseReturnTo;
  navigation: ScreenNavigation;
  onOpenApiKey: () => void;
  guard: HeldExitGuard;
}): React.JSX.Element {
  const { flush, flushForExit } = ctl.autosave;
  return (
    <View style={styles.entryExitRow} testID="journal-entry-exit-row">
      <ReturnToReadingLink
        returnTo={returnTo}
        navigation={navigation}
        flush={flush}
        guard={guard}
      />
      <ApiKeySettingsLink onPress={onOpenApiKey} />
      {ctl.editGate.editMode ? <PhotographPageButton onPress={ctl.photograph.openCapture} /> : null}
      <CloseEntryLink navigation={navigation} flush={flushForExit} guard={guard} />
    </View>
  );
}

/**
 * The rereadable sources panel, docked in the compose row beside the writing
 * sheet: a side pane where both fit, else a bottom sheet over the page (#2883).
 * Renders nothing unless a reflection's sources are open, so the plain and
 * weekly-prompt paths are untouched.
 */
function ReflectionSourcesDock({
  reflection,
}: {
  reflection: Controller['reflection'];
}): React.JSX.Element | null {
  // Read before the early return so the hook order is stable. The panel prints
  // dates beside a feed the SERVER windowed on this zone; formatting them in the
  // device's instead can show a day boundary the feed disagrees with.
  const { userTimezone } = useAuth();
  if (!(reflection.active && reflection.sourcesOpen)) return null;
  return (
    <ReflectionSourcesPanel
      items={reflection.sources}
      window={reflection.window}
      anchorStatus={reflection.anchorStatus}
      feedStatus={reflection.feedStatus}
      timeZone={userTimezone}
      onInsertQuote={reflection.onInsertQuote}
      onInsertQuotes={reflection.onInsertQuotes}
      foldedIds={reflection.foldedIds}
      onPromoteSpan={reflection.onPromoteSpan}
      onClose={reflection.closeSources}
    />
  );
}

/**
 * The writing sheet and, beside it where there is room, the open sources pane
 * (#2883). Below the side-pane width the dock renders a Modal sheet instead, and
 * the row holds the page alone, laid out exactly as it always was.
 */
function EntryComposeRow({
  ctl,
  bodyPlaceholder,
  focusSpan,
}: {
  ctl: Controller;
  bodyPlaceholder: string;
  focusSpan?: FocusSpan;
}): React.JSX.Element {
  return (
    <View style={styles.composeRow} testID="journal-compose-row">
      <JournalPage ctl={ctl} bodyPlaceholder={bodyPlaceholder} focusSpan={focusSpan} />
      <ReflectionSourcesDock reflection={ctl.reflection} />
    </View>
  );
}

/**
 * The reflection composer's warm hint, with its retry, when folded quotes could
 * not be marked included (#2885). Renders nothing outside reflection mode.
 */
function ReflectionComposer({
  reflection,
}: {
  reflection: Controller['reflection'];
}): React.JSX.Element | null {
  const { retryInclusion } = reflection;
  const onRetry = useCallback(() => {
    void retryInclusion();
  }, [retryInclusion]);
  if (!reflection.active) return null;
  return <QuoteInclusionHint failedCount={reflection.failedCount} onRetry={onRetry} />;
}

interface EntryScreenDrawer {
  drawer: ScreenDrawerState;
  onSelectEntry: (_id: number) => void;
  onNewEntry: () => void;
  onOpenCorpus: (_destination: CorpusDestination) => void;
  onOpenVoiceDrafts: () => void;
  onOpenPromotedQuotes: () => void;
}

/**
 * The header drawer wired for the entry screen. It latches its entry id at mount,
 * so a row tap and New entry must ``push`` a fresh screen (not ``navigate`` in
 * place, which would keep the current, already-loaded entry).
 */
function useEntryScreenDrawer(
  navigation: ScreenNavigation,
  quoteHandoffToken: () => string | undefined,
): EntryScreenDrawer {
  const drawer = useScreenDrawer('Journal');
  const onSelectEntry = useCallback(
    (entryId: number) => {
      navigation.push('JournalEntry', { entryId });
      drawer.close();
    },
    [navigation, drawer],
  );
  const onNewEntry = useCallback(() => {
    navigation.push('JournalEntry');
    drawer.close();
  }, [navigation, drawer]);
  const onOpenCorpus = useCallback(
    (destination: CorpusDestination) => navigation.navigate(destination),
    [navigation],
  );
  // The shelf sits beside the entry rather than above it, so it navigates in
  // place like the corpus door: pushing would stack a second Journal history.
  const onOpenVoiceDrafts = useCallback(() => {
    navigation.navigate('VoiceDrafts');
    drawer.close();
  }, [navigation, drawer]);
  // Promoted quotes is a place beside the entry too, so it navigates in place.
  // From a review being written it carries a hand-off token, so the screen can
  // fold a selection back into THIS page (#2885); from anything else, nothing.
  const onOpenPromotedQuotes = useCallback(() => {
    const injectInto = quoteHandoffToken();
    if (injectInto == null) navigation.navigate('PromotedQuotes');
    else navigation.navigate('PromotedQuotes', { injectInto });
    drawer.close();
  }, [navigation, drawer, quoteHandoffToken]);
  return {
    drawer,
    onSelectEntry,
    onNewEntry,
    onOpenCorpus,
    onOpenVoiceDrafts,
    onOpenPromotedQuotes,
  };
}

/** A modal owned by this entry must never outlive the route's foreground turn. */
function useCancelResonanceOnBlur(navigation: ScreenNavigation, cancelPending: () => void): void {
  useEffect(() => navigation.addListener?.('blur', cancelPending), [cancelPending, navigation]);
}

function useOpenApiKey(navigation: ScreenNavigation, cancelPending: () => void): () => void {
  useCancelResonanceOnBlur(navigation, cancelPending);
  return useCallback(() => {
    cancelPending();
    navigation.navigate('ApiKeySettings');
  }, [cancelPending, navigation]);
}

function ResonanceOverlays({
  explainer,
  onOpenApiKey,
}: {
  explainer: Controller['explainer'];
  onOpenApiKey: () => void;
}): React.JSX.Element {
  const openApiKey = useCallback(() => {
    explainer.onCancelRefill();
    onOpenApiKey();
  }, [explainer, onOpenApiKey]);
  return (
    <>
      <ResonanceExplainerDialog
        visible={explainer.visible}
        cost={explainer.cost}
        continueDisabled={explainer.continueDisabled}
        dontShowAgain={explainer.dontShowAgain}
        onToggleDontShowAgain={explainer.onToggleDontShowAgain}
        onContinue={explainer.onContinue}
        onCancel={explainer.onCancel}
      />
      <ResonanceRefillDialog
        visible={explainer.refillVisible}
        monthlyResetDate={explainer.monthlyResetDate}
        monthlyCap={explainer.monthlyCap}
        reason={explainer.refillReason}
        onAddKey={openApiKey}
        onCancel={explainer.onCancelRefill}
      />
    </>
  );
}

/** The screen's floating layers: the essay modal, the edit-confirm dialog, and
 *  the header drawer — grouped so the screen component stays under the line cap. */
function EntryOverlays({
  modal,
  editGate,
  explainer,
  entryDrawer,
  currentEntryId,
  onOpenApiKey,
}: {
  modal: Controller['modal'];
  editGate: Controller['editGate'];
  explainer: Controller['explainer'];
  entryDrawer: EntryScreenDrawer;
  currentEntryId: number | null;
  onOpenApiKey: () => void;
}): React.JSX.Element {
  return (
    <>
      <ResonanceOverlays explainer={explainer} onOpenApiKey={onOpenApiKey} />
      <ResonanceEssayModal
        note={modal.openNote}
        onClose={modal.onCloseNote}
        onEssayLoaded={modal.onEssayLoaded}
      />
      <EditConfirmDialog
        visible={editGate.confirmOpen}
        carriedWords={editGate.carriedWords}
        onEdit={editGate.confirmEdit}
        onStartNew={editGate.startNew}
        onCancel={editGate.cancelEdit}
      />
      <JournalScreenDrawer
        drawer={entryDrawer.drawer}
        currentEntryId={currentEntryId}
        onSelectEntry={entryDrawer.onSelectEntry}
        onNewEntry={entryDrawer.onNewEntry}
        onOpenCorpus={entryDrawer.onOpenCorpus}
        onOpenVoiceDrafts={entryDrawer.onOpenVoiceDrafts}
        onOpenPromotedQuotes={entryDrawer.onOpenPromotedQuotes}
      />
    </>
  );
}

/**
 * The writing surface's floating resonance affordance and its privacy-tier reason
 * line. Screen-level (not inside the page) so it can lift clear of the writing
 * area, and rendered in edit mode only — the reading view carries its own inline
 * action row instead.
 */
function ResonanceControls({
  visible,
  disabled,
  loading,
  checking,
  reason,
  onPress,
  layout = 'floating',
}: {
  visible: boolean;
  disabled: boolean;
  loading: boolean;
  checking: boolean;
  reason: string;
  onPress: () => Promise<void>;
  layout?: Exclude<ResonanceButtonLayout, 'inline'>;
}): React.JSX.Element {
  const content = (
    <>
      <PrivacyResonanceReason visible={visible && disabled} reason={reason} />
      <GetResonanceButton
        layout={layout}
        visible={visible}
        loading={loading}
        checking={checking}
        disabled={disabled}
        onPress={onPress}
      />
    </>
  );
  if (layout !== 'margin') return content;
  return (
    <View
      style={visible ? styles.marginResonanceControls : styles.marginResonanceControlsHidden}
      testID="journal-margin-resonance-controls"
    >
      {content}
    </View>
  );
}

/**
 * The writing surface's own screen-level siblings, in edit mode only.
 *
 * The timer lifts clear of the writing area, while resonance only floats here
 * on a narrow screen (wide screens host it in the margin). The timer's engine
 * ticks ten times a second, so whatever subtree hosts it repaints ten times a
 * second — and the subtree
 * that must not is the page holding the writer's text fields and live word
 * count. The reading view carries its own inline resonance action instead, and
 * has nothing to time.
 */
/**
 * What a finished writing session is offered as. A module-level constant, not a
 * closure: it has nothing to capture, and a new function each render would
 * remount the offer under a writer's thumb every time the page repainted. The
 * session it is handed is the one the note is about — the offer records it if
 * the writer keeps the session as a practice.
 */
const renderSessionOffer = (result: WritingSessionResult): React.ReactNode => (
  <WritingSessionOffer result={result} />
);

/** The launch this page was opened with, when it was opened to run a practice. */
type WritingLaunchParam = NonNullable<RootStackParamList['JournalEntry']>['writingSession'];

/**
 * A page opened by the quick launch runs the practice's session instead of
 * offering to make one: the timer opens at the practice's length and already
 * running, the finished session is recorded against the selection, and the
 * "keep this as a practice?" offer is withheld — the writer answered that
 * question already, which is how the practice exists to be launched from.
 */
function EntryWritingSurfaces({
  ctl,
  launch,
}: {
  ctl: Controller;
  launch: WritingLaunchParam;
}): React.JSX.Element | null {
  const session = useQuickLaunchedSession(launch);
  // Above the edit-mode return, beside the practice hook it wraps: both kinds
  // of page finish through this one handler, so a linked habit is checked off
  // on either (#2861).
  const onSession = useLinkedHabitCheckOff(session.onSession);
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  if (!ctl.editGate.editMode) return null;
  return (
    <>
      <WritingSessionSurface
        initialMinutes={session.initialMinutes}
        autoStart={session.autoStart}
        onSession={onSession}
        renderOffer={session.launched ? undefined : renderSessionOffer}
      />
      {narrow ? (
        <ResonanceControls
          visible={ctl.visible}
          disabled={ctl.resonanceDisabled}
          loading={ctl.resonance.loading}
          checking={ctl.explainer.pending}
          reason={ctl.resonanceReason}
          onPress={ctl.explainer.onPress}
        />
      ) : null}
    </>
  );
}

/**
 * The two screen-level care siblings rendered ABOVE the page (NORTH-STAR §10):
 * the acute-distress support surface first, then the warmer foundation reflection,
 * so a distress signal always reads before the gentler nudge. Both are siblings of
 * the page — never nested in the margin column — and hide on a healthy pass.
 */
function EntryCareSurfaces({ ctl }: { ctl: Controller }): React.JSX.Element {
  return (
    <>
      <CareSupportNote care={ctl.resonance.care} />
      <ContractionReflectionNote contraction={ctl.resonance.contraction} />
    </>
  );
}

/** Corpus-level vault pages sit beside the journal page, never in its margin. */
function EntryCreekSurface({ ctl }: { ctl: Controller }): React.JSX.Element | null {
  return (
    <FromYourCreekPanel praxis={ctl.resonance.relatedPraxis} eddies={ctl.resonance.relatedEddies} />
  );
}

/**
 * The corpus decision, offered beside the page once a first reflection has
 * actually arrived (#2407). A screen-level sibling like the care surfaces --
 * never in the margin column -- and, like them, silent unless the server says
 * otherwise. Looking at the decision is routed here because the screen owns
 * navigation; the note owns everything else.
 */
function EntryCorpusInvitation({
  ctl,
  navigation,
}: {
  ctl: Controller;
  navigation: ScreenNavigation;
}): React.JSX.Element {
  const onOpen = useCallback(() => navigation.navigate('CorpusConsent'), [navigation]);
  return <CorpusInvitationNote completedPasses={ctl.resonance.completedPasses} onOpen={onOpen} />;
}

/**
 * This page's end of the Promoted quotes hand-off (#2885). A selection folds
 * only into a review (the server marks a quote included nowhere else, #1458),
 * and only while that review is hydrated and editable. Returns the drawer's
 * token source: a fresh token while the page can fold, else none.
 */
function useEntryQuoteHandoff(
  ctl: Controller,
  routeToken: string | undefined,
): () => string | undefined {
  const ready = ctl.reflection.active && ctl.editGate.editMode;
  const { mint } = usePromotedQuoteHandoff({
    ready,
    routeToken,
    onInsertQuotes: ctl.reflection.onInsertQuotes,
  });
  return useCallback(() => (ready ? mint() : undefined), [ready, mint]);
}

/** The header drawer, its Promoted quotes door carrying this page's hand-off. */
function useEntryDrawerWithHandoff(
  navigation: ScreenNavigation,
  ctl: Controller,
  routeToken: string | undefined,
): EntryScreenDrawer {
  return useEntryScreenDrawer(navigation, useEntryQuoteHandoff(ctl, routeToken));
}

function JournalEntryScreen({
  route,
  navigation,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: JournalEntryScreenProps): React.JSX.Element {
  const { ctx, initialText, bodyPlaceholder, initialClassification } = readEntrypoint(route.params);
  const currentEntryId = route.params?.entryId ?? null;
  const justSaved = route.params?.justSaved ?? false;
  const ctl = useJournalEntryController(
    currentEntryId,
    autosaveDelayMs,
    navigation,
    ctx,
    initialText,
    justSaved,
    initialClassification,
  );
  const entryDrawer = useEntryDrawerWithHandoff(navigation, ctl, route.params?.injectQuotes);
  const openApiKey = useOpenApiKey(navigation, ctl.explainer.cancelPending);
  return (
    <SafeAreaView style={styles.safeArea} testID="journal-screen">
      <EntryCareSurfaces ctl={ctl} />
      <EntryCreekSurface ctl={ctl} />
      <EntryCorpusInvitation ctl={ctl} navigation={navigation} />
      <EntryNotices autosave={ctl.autosave} />
      <EntryExits
        ctl={ctl}
        navigation={navigation}
        returnTo={route.params?.returnTo}
        onOpenApiKey={openApiKey}
      />
      <EntryComposeRow
        ctl={ctl}
        bodyPlaceholder={bodyPlaceholder}
        focusSpan={route.params?.highlightSpan}
      />
      <ReflectionComposer reflection={ctl.reflection} />
      <EntryWritingSurfaces ctl={ctl} launch={route.params?.writingSession} />
      <EntryOverlays
        modal={ctl.modal}
        editGate={ctl.editGate}
        explainer={ctl.explainer}
        entryDrawer={entryDrawer}
        currentEntryId={currentEntryId}
        onOpenApiKey={openApiKey}
      />
    </SafeAreaView>
  );
}

export default JournalEntryScreen;
