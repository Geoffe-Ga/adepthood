/**
 * ``useReflectionMode`` — the reflection-composer glue for ``JournalEntryScreen``.
 *
 * Active only when the screen was opened with a reflection scope. It fetches the
 * rereadable sources feed on mount, tracks the body caret so a folded-in quote
 * lands where the writer left off, and folds a chosen quote into the body: splice
 * a Markdown blockquote at the caret, let the normal draft path create/save the
 * entry, then mark the quote included on that entry. A failed inclusion leaves
 * the quote pending and raises a warm, declinable hint — never a crash, never a
 * nag. It also re-promotes a freshly selected span from a source and folds the
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

import { formatBlockquote, sourceAttribution } from './reflectionCopy';

import { promotions, reflections } from '@/api';
import type {
  PromoteQuoteSpan,
  PromotedQuote,
  PromotedQuoteSummary,
  ReflectionLevel,
  ReflectionSourceItem,
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
  /** Set when a folded quote could not be marked included; drives a warm hint. */
  inclusionHint: boolean;
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

/** Fetch the rereadable sources feed for a reflection scope (hidden on any error). */
function useSourcesFeed(
  reflectionLevel: ReflectionLevel | undefined,
  reflectionScopeKey: string | undefined,
): [ReflectionSourceItem[], Dispatch<SetStateAction<ReflectionSourceItem[]>>] {
  const [sources, setSources] = useState<ReflectionSourceItem[]>([]);
  useEffect(() => {
    if (reflectionLevel == null || reflectionScopeKey == null) return undefined;
    let alive = true;
    void reflections
      .sources(reflectionLevel, reflectionScopeKey)
      .then((result) => {
        if (alive) setSources(result.items);
      })
      .catch(() => {
        // The composer works without the feed; a fetch failure just hides it.
      });
    return () => {
      alive = false;
    };
  }, [reflectionLevel, reflectionScopeKey]);
  return [sources, setSources];
}

/** The caret tracker plus the fold-a-pending-quote-into-the-body flow. */
function useFoldIn(
  bodyRef: MutableRefObject<string>,
  onChangeBody: (_next: string) => void,
  flush: () => Promise<number | null>,
): {
  inclusionHint: boolean;
  onBodySelectionChange: (_e: SelectionEvent) => void;
  onInsertQuote: (
    _quote: PromotedQuoteSummary,
    _sourceItem: ReflectionSourceItem,
  ) => Promise<boolean>;
} {
  const [inclusionHint, setInclusionHint] = useState(false);
  const caretRef = useRef<number | null>(null);

  const onBodySelectionChange = useCallback((event: SelectionEvent) => {
    caretRef.current = event.nativeEvent.selection.start;
  }, []);

  const onInsertQuote = useCallback(
    async (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): Promise<boolean> => {
      const block = formatBlockquote(quote.anchor_text, sourceAttribution(sourceItem));
      const { text, nextCaret } = spliceAtCaret(bodyRef.current, block, caretRef.current);
      onChangeBody(text);
      caretRef.current = nextCaret;
      const entryId = await flush();
      if (entryId == null) return false;
      try {
        await promotions.setIncluded(quote.id, entryId);
        // A retried fold-in should not leave a stale warning from an earlier try.
        setInclusionHint(false);
        return true;
      } catch {
        // Leave the quote pending and invite a calm retry — no crash, no nag.
        setInclusionHint(true);
        return false;
      }
    },
    [bodyRef, onChangeBody, flush],
  );

  return { inclusionHint, onBodySelectionChange, onInsertQuote };
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
  const [sources, setSources] = useSourcesFeed(reflectionLevel, reflectionScopeKey);
  const { inclusionHint, onBodySelectionChange, onInsertQuote } = useFoldIn(
    bodyRef,
    onChangeBody,
    flush,
  );
  const onPromoteSpan = usePromoteSpan(setSources);

  return { active, sources, inclusionHint, onBodySelectionChange, onInsertQuote, onPromoteSpan };
}
