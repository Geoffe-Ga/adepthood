/**
 * ``useReflectionMode`` — the reflection-composer glue for ``JournalEntryScreen``.
 *
 * Active only when the screen was opened with a reflection scope. It fetches the
 * rereadable sources feed on mount, tracks the body caret so a folded-in quote
 * lands where the writer left off, and folds a chosen quote into the body: splice
 * a Markdown blockquote at the caret, let the normal draft path create/save the
 * entry, then mark the quote included on that entry. A failed inclusion leaves
 * the quote pending and raises a warm, declinable hint — never a crash, never a
 * nag.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native';

import { formatBlockquote, sourceAttribution } from './reflectionCopy';

import { promotions, reflections } from '@/api';
import type { PromotedQuoteSummary, ReflectionLevel, ReflectionSourceItem } from '@/api';

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
  /** Fold a chosen pending quote into the reflection body. */
  onInsertQuote: (_quote: PromotedQuoteSummary, _sourceItem: ReflectionSourceItem) => void;
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

/** Fetch the rereadable sources feed for a reflection scope (hidden on any error). */
function useSourcesFeed(
  reflectionLevel: ReflectionLevel | undefined,
  reflectionScopeKey: string | undefined,
): ReflectionSourceItem[] {
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
  return sources;
}

export function useReflectionMode({
  reflectionLevel,
  reflectionScopeKey,
  bodyRef,
  onChangeBody,
  flush,
}: UseReflectionModeArgs): UseReflectionModeResult {
  const active = reflectionLevel != null && reflectionScopeKey != null;
  const sources = useSourcesFeed(reflectionLevel, reflectionScopeKey);
  const [inclusionHint, setInclusionHint] = useState(false);
  const caretRef = useRef<number | null>(null);

  const onBodySelectionChange = useCallback((event: SelectionEvent) => {
    caretRef.current = event.nativeEvent.selection.start;
  }, []);

  const foldIn = useCallback(
    async (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): Promise<void> => {
      const block = formatBlockquote(quote.anchor_text, sourceAttribution(sourceItem));
      const { text, nextCaret } = spliceAtCaret(bodyRef.current, block, caretRef.current);
      onChangeBody(text);
      caretRef.current = nextCaret;
      const entryId = await flush();
      if (entryId == null) return;
      try {
        await promotions.setIncluded(quote.id, entryId);
      } catch {
        // Leave the quote pending and invite a calm retry — no crash, no nag.
        setInclusionHint(true);
      }
    },
    [bodyRef, onChangeBody, flush],
  );

  const onInsertQuote = useCallback(
    (quote: PromotedQuoteSummary, sourceItem: ReflectionSourceItem): void => {
      void foldIn(quote, sourceItem);
    },
    [foldIn],
  );

  return { active, sources, inclusionHint, onBodySelectionChange, onInsertQuote };
}
