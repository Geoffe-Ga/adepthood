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
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native';

import { formatBlockquote, sourceAttribution, type ReviewWindow } from './reflectionCopy';

import { promotions, reflections } from '@/api';
import type {
  PromoteQuoteSpan,
  PromotedQuote,
  PromotedQuoteSummary,
  ReflectionLevel,
  ReflectionSourceItem,
  ReflectionSourcesResponse,
} from '@/api';

type SelectionEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;

export interface UseReflectionModeArgs {
  reflectionLevel?: ReflectionLevel;
  reflectionScopeKey?: string;
  /** The latest body text (read to splice a quote at the caret). */
  bodyRef: MutableRefObject<string>;
  /** The screen's body change handler (updates state + schedules the draft save). */
  onChangeBody: (_next: string) => void;
  /** Persist the draft now and resolve to the entry id (single-flight writer). */
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
  /** Set when a folded quote could not be marked included; drives a warm hint. */
  inclusionHint: boolean;
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
  onBodySelectionChange: (_e: SelectionEvent) => void;
  /** Fold a chosen pending quote in; resolves true when it was marked included. */
  onInsertQuote: (
    _quote: PromotedQuoteSummary,
    _sourceItem: ReflectionSourceItem,
  ) => Promise<boolean>;
  /** Promote a freshly selected span of a source; resolves true on success. */
  onPromoteSpan: (_sourceItem: ReflectionSourceItem, _span: PromoteQuoteSpan) => Promise<boolean>;
}

/**
 * Splice ``block`` into ``body`` at ``caret`` (or the end when untracked),
 * returning the new text and the caret position just past the inserted block so
 * a second fold-in lands after the first rather than re-splitting it.
 */
function spliceAtCaret(
  body: string,
  block: string,
  caret: number | null,
): { text: string; nextCaret: number } {
  const at = caret == null ? body.length : Math.min(caret, body.length);
  return { text: body.slice(0, at) + block + body.slice(at), nextCaret: at + block.length };
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
 */
function useSourcesFeed(
  reflectionLevel: ReflectionLevel | undefined,
  reflectionScopeKey: string | undefined,
): SourcesFeed {
  const [sources, setSources] = useState<ReflectionSourceItem[]>([]);
  const [window, setWindow] = useState<ReviewWindow | undefined>(undefined);
  useEffect(() => {
    setSources([]);
    setWindow(undefined);
    if (reflectionLevel == null || reflectionScopeKey == null) return undefined;
    let alive = true;
    void reflections
      .sources(reflectionLevel, reflectionScopeKey)
      .then((result) => {
        if (!alive) return;
        setSources(result.items);
        setWindow(declaredWindow(result));
      })
      .catch(() => {
        // The composer works without the feed; a fetch failure just hides it.
      });
    return () => {
      alive = false;
    };
  }, [reflectionLevel, reflectionScopeKey]);
  return { sources, setSources, window };
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

/** The caret tracker plus the fold-a-pending-quote-into-the-body flow. */
function useFoldIn(
  bodyRef: MutableRefObject<string>,
  onChangeBody: (_next: string) => void,
  flush: () => Promise<number | null>,
): {
  inclusionHint: boolean;
  foldingIn: boolean;
  onBodySelectionChange: (_e: SelectionEvent) => void;
  onInsertQuote: (
    _quote: PromotedQuoteSummary,
    _sourceItem: ReflectionSourceItem,
  ) => Promise<boolean>;
} {
  const [inclusionHint, setInclusionHint] = useState(false);
  const { anyInFlight, track } = useInFlightTally();
  const caretRef = useRef<number | null>(null);

  const onBodySelectionChange = useCallback((event: SelectionEvent) => {
    caretRef.current = event.nativeEvent.selection.start;
  }, []);

  const foldQuoteIn = useCallback(
    async (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): Promise<boolean> => {
      const block = formatBlockquote(quote.anchor_text, sourceAttribution(sourceItem));
      const { text, nextCaret } = spliceAtCaret(bodyRef.current, block, caretRef.current);
      onChangeBody(text);
      caretRef.current = nextCaret;
      const entryId = await flush();
      if (entryId == null) return false;
      // Set both ways round: a retried fold-in clears the warning an earlier try
      // left, and a refused one raises it — no crash, no nag either way.
      const included = await markIncluded(quote.id, entryId);
      setInclusionHint(!included);
      return included;
    },
    [bodyRef, onChangeBody, flush],
  );

  // Tracked over the WHOLE act, not just the entry write: the draft save
  // resolves first and settles the screen's own hint to "Saved" while the quote
  // is still pending, so the tally is what holds the hint open until the mark
  // lands — for this act and for any other still outstanding.
  const onInsertQuote = useCallback(
    (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): Promise<boolean> =>
      track(() => foldQuoteIn(quote, sourceItem)),
    [track, foldQuoteIn],
  );

  return { inclusionHint, foldingIn: anyInFlight, onBodySelectionChange, onInsertQuote };
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
  const { sources, setSources, window } = useSourcesFeed(reflectionLevel, reflectionScopeKey);
  const { inclusionHint, foldingIn, onBodySelectionChange, onInsertQuote } = useFoldIn(
    bodyRef,
    onChangeBody,
    flush,
  );
  const onPromoteSpan = usePromoteSpan(setSources);

  return {
    active,
    sources,
    window,
    inclusionHint,
    foldingIn,
    onBodySelectionChange,
    onInsertQuote,
    onPromoteSpan,
  };
}
