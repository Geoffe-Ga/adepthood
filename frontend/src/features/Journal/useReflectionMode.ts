/**
 * ``useReflectionMode`` — the reflection-composer glue for ``JournalEntryScreen``.
 *
 * Active only when the screen was opened with a reflection scope. It fetches the
 * rereadable sources feed on mount, tracks the body caret so a folded-in quote
 * lands where the writer left off, and folds a chosen quote into the body: splice
 * a Markdown blockquote at the caret, let the normal draft path create/save the
 * entry, then mark the quote included on that entry. Both writes are one act, so
 * ``foldingIn`` stays raised across the pair -- and across every act still
 * outstanding, since a writer may fold a second quote in before the first has
 * landed -- and the screen's save hint waits for the marks rather than settling
 * on a draft save alone. A failed inclusion
 * leaves the quote pending and raises a warm, declinable hint — never a crash,
 * never a nag. It also re-promotes a freshly selected span from a source and folds the
 * created quote into the feed's pending set.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { candidateFromSource, planQuoteBatch, type FoldCandidate } from './quoteBatch';
import type { ReviewWindow } from './reflectionCopy';
import type { SourcesFeedStatus } from './ReflectionSourcesPanel';

import { promotions, reflections } from '@/api';
import type {
  PromoteQuoteSpan,
  PromotedQuote,
  PromotedQuoteSummary,
  ReflectionAnchorStatus,
  ReflectionLevel,
  ReflectionSourceItem,
  ReflectionSourcesResponse,
} from '@/api';

/** A caret the body field reported, in UTF-16 code units. */
type BodyCaret = { start: number; end: number };

export interface UseReflectionModeArgs {
  reflectionLevel?: ReflectionLevel;
  reflectionScopeKey?: string;
  /** The latest body text (read to splice a quote at the caret). */
  bodyRef: MutableRefObject<string>;
  /** The screen's body change handler (updates state + schedules the draft save). */
  onChangeBody: (_next: string) => void;
  /**
   * Persist the draft now and resolve to the entry id -- or null unless the
   * body is DURABLE. Every fold (a single tap and a batch alike) marks quotes
   * included only against a non-null id, so a failed write leaves them all on
   * the retry list, and a retry re-flushes before it re-marks.
   */
  flush: () => Promise<number | null>;
}

export interface UseReflectionModeResult {
  /** True when the screen is composing a reflection (both scope fields present). */
  active: boolean;
  /** The rereadable entries + earlier reflections in scope. */
  sources: ReflectionSourceItem[];
  /**
   * The period the SERVER filtered the feed on, for the panel to name. Undefined
   * while a scope is loading, when the fetch failed, and whenever the server
   * declared no window — the panel then shows no period rather than one the
   * client derived, which could disagree with the feed beneath it.
   */
  window: ReviewWindow | undefined;
  /**
   * Why the server drew that window, when it said. ``'unrecorded'`` names a past
   * cycle whose anchor beginning again destroyed, so its period cannot be
   * rebuilt; the panel says so rather than implying the weeks were empty.
   * Undefined against a server that predates the field.
   */
  anchorStatus: ReflectionAnchorStatus | undefined;
  /**
   * How far the sources request has got. The panel needs this SEPARATELY from
   * ``anchorStatus``: a feed still in flight, or one whose request failed, knows
   * nothing about the period, and an empty list in either case is the absence of
   * an answer rather than the answer "nothing was written".
   */
  feedStatus: SourcesFeedStatus;
  /** Set when a folded quote could not be marked included; drives a warm hint. */
  inclusionHint: boolean;
  /** How many folded quotes are still waiting on their inclusion mark. */
  failedCount: number;
  /**
   * Every quote this composer has folded in AND marked, however it got here --
   * a panel tap, a panel selection, or a hand-off from the Promoted quotes
   * screen -- so the panel shows it folded when it next opens.
   */
  foldedIds: ReadonlySet<number>;
  /**
   * True while ANY fold-in is outstanding: from the tap on a pending quote until
   * the whole act has settled -- the entry write AND the mark that retires the
   * quote from the pending set. Fold-ins overlap freely (a writer gathering
   * several quotes taps them in succession, and each is a round trip), so this
   * reads a count of outstanding acts rather than a single shared flag. The
   * screen holds its save hint at "Saving…" for the span, so the page never says
   * "Saved" while a write belonging to one of those acts is still on the wire.
   */
  foldingIn: boolean;
  /** Track the body caret so an inserted quote lands where the writer is. */
  onBodySelectionChange: (_caret: BodyCaret) => void;
  /** Fold a chosen pending quote in; resolves true when it was marked included. */
  onInsertQuote: (
    _quote: PromotedQuoteSummary,
    _sourceItem: ReflectionSourceItem,
  ) => Promise<boolean>;
  /**
   * Fold a whole selection in (#2885): ONE body change at the caret, in the
   * order given, ONE entry write, then one inclusion mark per quote.
   */
  onInsertQuotes: (_candidates: readonly FoldCandidate[]) => Promise<BatchFoldResult>;
  /** Re-mark only the quotes whose mark failed; the body already holds them. */
  retryInclusion: () => Promise<BatchFoldResult>;
  /** Promote a freshly selected span of a source; resolves true on success. */
  onPromoteSpan: (_sourceItem: ReflectionSourceItem, _span: PromoteQuoteSpan) => Promise<boolean>;
}

/** True when ``item`` is the source a created quote belongs to (kind + id). */
function isSameSource(item: ReflectionSourceItem, sourceItem: ReflectionSourceItem): boolean {
  return item.kind === sourceItem.kind && item.id === sourceItem.id;
}

/**
 * Append the created quote (as a feed summary, minus ``source_entry_id``) onto
 * its source item's pending set, leaving every other item untouched.
 */
function mergeCreatedQuote(
  items: ReflectionSourceItem[],
  sourceItem: ReflectionSourceItem,
  created: PromotedQuote,
): ReflectionSourceItem[] {
  const summary: PromotedQuoteSummary = {
    id: created.id,
    anchor_start: created.anchor_start,
    anchor_end: created.anchor_end,
    anchor_text: created.anchor_text,
    pending: created.pending,
  };
  return items.map((item) =>
    isSameSource(item, sourceItem)
      ? { ...item, promoted_quotes: [...item.promoted_quotes, summary] }
      : item,
  );
}

/** The period a response declared, or undefined when the server named none. */
function declaredWindow(result: ReflectionSourcesResponse): ReviewWindow | undefined {
  const start = result.window_start;
  const end = result.window_end;
  return start != null && end != null ? { start, end } : undefined;
}

interface SourcesFeed {
  sources: ReflectionSourceItem[];
  setSources: Dispatch<SetStateAction<ReflectionSourceItem[]>>;
  window: ReviewWindow | undefined;
  anchorStatus: ReflectionAnchorStatus | undefined;
  feedStatus: SourcesFeedStatus;
}

/**
 * Fetch the rereadable sources feed, and the period it was drawn from, for the
 * reflection scope currently on screen. Hidden on any error — the composer works
 * without the feed.
 *
 * The feed and its period are cleared the INSTANT the scope changes, before the
 * new fetch is even sent, and the effect's cleanup retires the request in flight
 * for the scope being left. Both matter for the same reason: a slow or refused
 * switch must leave an empty panel, never the previous review's material sitting
 * under the new review's heading. A 403 ``scope_locked`` takes the ``.catch``
 * path, so the clearing has to happen up front rather than in the success branch.
 *
 * The emptiness that clearing produces is deliberately NOT silent any more. The
 * feed reports whether it is still asking, has settled, or failed, because an
 * empty list means three different things in those three cases and the panel
 * has to say which. Hiding a failure behind "nothing was written in this period"
 * tells the writer something false about their own journal.
 */
function useSourcesFeed(
  reflectionLevel: ReflectionLevel | undefined,
  reflectionScopeKey: string | undefined,
): SourcesFeed {
  const [sources, setSources] = useState<ReflectionSourceItem[]>([]);
  const [window, setWindow] = useState<ReviewWindow | undefined>(undefined);
  const [anchorStatus, setAnchorStatus] = useState<ReflectionAnchorStatus | undefined>(undefined);
  const [feedStatus, setFeedStatus] = useState<SourcesFeedStatus>('ready');
  useEffect(() => {
    setSources([]);
    setWindow(undefined);
    setAnchorStatus(undefined);
    if (reflectionLevel == null || reflectionScopeKey == null) {
      setFeedStatus('ready');
      return undefined;
    }
    setFeedStatus('loading');
    let alive = true;
    void reflections
      .sources(reflectionLevel, reflectionScopeKey)
      .then((result) => {
        if (!alive) return;
        setSources(result.items);
        setWindow(declaredWindow(result));
        setAnchorStatus(result.anchor_status);
        setFeedStatus('ready');
      })
      .catch(() => {
        // The composer still works without the feed, but the panel must say the
        // sources did not arrive rather than showing the empty-period copy.
        if (!alive) return;
        setFeedStatus('failed');
      });
    return () => {
      alive = false;
    };
  }, [reflectionLevel, reflectionScopeKey]);
  return { sources, setSources, window, anchorStatus, feedStatus };
}

/**
 * Mark ``quoteId`` folded into ``entryId``, reporting whether it took. A refusal
 * is not an error here: the quote simply stays pending and the writer can fold
 * it again later, so the caller raises a warm hint rather than crashing.
 */
async function markIncluded(quoteId: number, entryId: number): Promise<boolean> {
  try {
    await promotions.setIncluded(quoteId, entryId);
    return true;
  } catch {
    return false;
  }
}

/**
 * A tally of the acts currently outstanding, and the wrapper that keeps it
 * honest.
 *
 * A count rather than a flag, because fold-ins overlap: the panel's "already
 * folded in" guard is per row, so nothing stops a writer folding a second quote
 * in while the first is still on the wire, and a shared boolean would be lowered
 * by whichever act finished first — announcing a save the other had not made.
 *
 * A count is only sound if every raise is matched by exactly one lower on every
 * path, which is what the ``finally`` gives: a rejected act settles the tally
 * rather than stranding it. Both updates are functional, so two taps in one tick
 * cannot read the same stale count and collapse into one.
 */
function useInFlightTally(): {
  anyInFlight: boolean;
  track: <T>(_act: () => Promise<T>) => Promise<T>;
} {
  const [count, setCount] = useState(0);
  const track = useCallback(async <T>(act: () => Promise<T>): Promise<T> => {
    setCount((outstanding) => outstanding + 1);
    try {
      return await act();
    } finally {
      setCount((outstanding) => outstanding - 1);
    }
  }, []);
  return { anyInFlight: count > 0, track };
}

/**
 * The quote folds currently on the wire, one per quote: a second tap on a quote
 * whose first fold has not settled is refused rather than racing it.
 */
function useFoldsInFlight() {
  const inFlightRef = useRef(new Set<number>());
  return useMemo(
    () => ({
      begin: (id: number): boolean => {
        if (inFlightRef.current.has(id)) return false;
        inFlightRef.current.add(id);
        return true;
      },
      end: (id: number): void => {
        inFlightRef.current.delete(id);
      },
    }),
    [],
  );
}

/** What one batch fold-in did with each quote it was handed, by id. */
export interface BatchFoldResult {
  /** Folded into the body AND marked included on the entry. */
  included: number[];
  /** In the body (or not, if the entry write failed) but NOT marked; kept for a retry. */
  failed: number[];
  /** Already on the wire from an earlier tap or batch, so left to that act. */
  skipped: number[];
}

/**
 * The quotes whose inclusion mark has not landed, kept by id so a retry can
 * re-mark exactly those. ``failedCount`` mirrors the map's size as state, so
 * the composer's retry hint re-renders; ``foldedIds`` gains every quote that
 * was marked, so the panel can show it folded however it got there.
 */
function useInclusionLedger() {
  const failedRef = useRef(new Map<number, FoldCandidate>());
  const [failedCount, setFailedCount] = useState(0);
  const [foldedIds, setFoldedIds] = useState<ReadonlySet<number>>(() => new Set<number>());
  const record = useCallback((candidates: readonly FoldCandidate[], marked: readonly boolean[]) => {
    const included = candidates.filter((_candidate, index) => marked[index]);
    for (const candidate of candidates) failedRef.current.set(candidate.id, candidate);
    for (const candidate of included) failedRef.current.delete(candidate.id);
    setFailedCount(failedRef.current.size);
    const includedIds = included.map((candidate) => candidate.id);
    if (includedIds.length > 0) setFoldedIds((prev) => new Set([...prev, ...includedIds]));
  }, []);
  const failedCandidates = useCallback(() => [...failedRef.current.values()], []);
  return { failedCount, foldedIds, record, failedCandidates };
}

/** Split a batch's outcome by id: which quotes were marked, and which were not. */
function batchOutcome(
  admitted: readonly FoldCandidate[],
  marked: readonly boolean[],
  skipped: number[],
): BatchFoldResult {
  const ids = (want: boolean) =>
    admitted.filter((_candidate, index) => marked[index] === want).map((candidate) => candidate.id);
  return { included: ids(true), failed: ids(false), skipped };
}

/** Fold a batch of candidates in, resolving to what became of each. */
type FoldBatch = (_candidates: readonly FoldCandidate[]) => Promise<BatchFoldResult>;

/** The marks for an admitted batch: none at all when the entry write failed. */
function markAll(admitted: readonly FoldCandidate[], entryId: number | null): Promise<boolean[]> {
  if (entryId == null) return Promise.resolve(admitted.map(() => false));
  return Promise.all(admitted.map((candidate) => markIncluded(candidate.id, entryId)));
}

/**
 * One batch's two writes, untracked: splice what the body lacks at the caret,
 * write the entry once, then mark each quote. Refuses, per quote, any quote an
 * earlier act still has on the wire.
 */
function useFoldBatch(
  bodyRef: MutableRefObject<string>,
  caretRef: MutableRefObject<number | null>,
  write: { onChangeBody: (_next: string) => void; flush: () => Promise<number | null> },
  record: (_candidates: readonly FoldCandidate[], _marked: readonly boolean[]) => void,
): FoldBatch {
  const inFlight = useFoldsInFlight();
  const { onChangeBody, flush } = write;
  return useCallback<FoldBatch>(
    async (candidates) => {
      // Per quote, not per batch: a quote a single tap already has on the wire
      // is left to that act, and the rest of the selection still goes in.
      const admitted = candidates.filter((candidate) => inFlight.begin(candidate.id));
      const skipped = candidates.filter((c) => !admitted.includes(c)).map((c) => c.id);
      if (admitted.length === 0) return { included: [], failed: [], skipped };
      try {
        // A fold-in is two writes: the blocks land in the body, then each quote
        // is marked included. When a mark fails its block has ALREADY landed,
        // and it stays in the saved body across a close and reopen -- so the
        // body itself, not anything held in memory, says whether a retry still
        // needs to splice it. If the writer deleted it meanwhile, it goes back
        // once rather than marking a quote included that the review omits.
        const plan = planQuoteBatch(bodyRef.current, admitted, caretRef.current);
        if (plan.text !== bodyRef.current) {
          onChangeBody(plan.text);
          caretRef.current = plan.nextCaret;
        }
        const marked = await markAll(admitted, await flush());
        // Recorded both ways round: a retried quote clears the warning an
        // earlier try left, and a refused one raises it -- no crash, no nag.
        record(admitted, marked);
        return batchOutcome(admitted, marked, skipped);
      } finally {
        for (const candidate of admitted) inFlight.end(candidate.id);
      }
    },
    [bodyRef, caretRef, onChangeBody, flush, inFlight, record],
  );
}

/** The caret tracker plus the fold-pending-quotes-into-the-body flow. */
function useFoldIn(
  bodyRef: MutableRefObject<string>,
  onChangeBody: (_next: string) => void,
  flush: () => Promise<number | null>,
) {
  const { anyInFlight, track } = useInFlightTally();
  const caretRef = useRef<number | null>(null);
  const ledger = useInclusionLedger();
  const { record, failedCandidates } = ledger;

  const onBodySelectionChange = useCallback((caret: BodyCaret) => {
    caretRef.current = caret.start;
  }, []);

  const foldBatch = useFoldBatch(bodyRef, caretRef, { onChangeBody, flush }, record);

  // Tracked over the WHOLE act, not just the entry write: the draft save
  // resolves first and settles the screen's own hint to "Saved" while the
  // quotes are still pending, so the tally is what holds the hint open until
  // every mark lands -- for this act and for any other still outstanding. An
  // empty batch admits nothing, so it splices, writes and marks nothing.
  const onInsertQuotes = useCallback<FoldBatch>(
    (candidates) => track(() => foldBatch(candidates)),
    [track, foldBatch],
  );

  const retryInclusion = useCallback(
    () => onInsertQuotes(failedCandidates()),
    [onInsertQuotes, failedCandidates],
  );

  const onInsertQuote = useCallback(
    async (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): Promise<boolean> => {
      const outcome = await onInsertQuotes([candidateFromSource(quote, sourceItem)]);
      return outcome.included.includes(quote.id);
    },
    [onInsertQuotes],
  );

  return {
    inclusionHint: ledger.failedCount > 0,
    failedCount: ledger.failedCount,
    foldedIds: ledger.foldedIds,
    foldingIn: anyInFlight,
    onBodySelectionChange,
    onInsertQuote,
    onInsertQuotes,
    retryInclusion,
  };
}

/** The in-panel re-promote flow: lift a fresh span into its source's pending set. */
function usePromoteSpan(
  setSources: Dispatch<SetStateAction<ReflectionSourceItem[]>>,
): (_sourceItem: ReflectionSourceItem, _span: PromoteQuoteSpan) => Promise<boolean> {
  // One re-promote at a time so a double press can't double-post the same span.
  const promotingRef = useRef(false);
  return useCallback(
    async (sourceItem: ReflectionSourceItem, span: PromoteQuoteSpan): Promise<boolean> => {
      if (promotingRef.current) return false;
      promotingRef.current = true;
      try {
        const created = await promotions.create(sourceItem.id, span);
        setSources((prev) => mergeCreatedQuote(prev, sourceItem, created));
        return true;
      } catch {
        // The source is unchanged and the writer can try again — no crash, no nag.
        return false;
      } finally {
        promotingRef.current = false;
      }
    },
    [setSources],
  );
}

export function useReflectionMode({
  reflectionLevel,
  reflectionScopeKey,
  bodyRef,
  onChangeBody,
  flush,
}: UseReflectionModeArgs): UseReflectionModeResult {
  const active = reflectionLevel != null && reflectionScopeKey != null;
  const { sources, setSources, window, anchorStatus, feedStatus } = useSourcesFeed(
    reflectionLevel,
    reflectionScopeKey,
  );
  const foldIn = useFoldIn(bodyRef, onChangeBody, flush);
  const onPromoteSpan = usePromoteSpan(setSources);

  return { active, sources, window, anchorStatus, feedStatus, ...foldIn, onPromoteSpan };
}
