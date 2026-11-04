/**
 * ``QuoteSelectionSurface`` — a controlled, effectively read-only serif field
 * that mirrors a body so the reader can select a passage to promote without
 * editing it (soft keyboard suppressed, caret hidden; ``editable`` stays true so
 * Android text selection still works). It guides the whole gesture in place: a
 * warm instruction line worded for the platform's own gesture (long press on a
 * phone, mouse or keyboard in a browser -- see ``selectionSurfaceCopy.ts``), a
 * live preview that echoes the raw selection back, and a confirm.
 *
 * The confirm comes to the selection (#3134): the moment a non-empty passage
 * is chosen, a floating "Promote selection" pill (``FloatingPromoteButton``)
 * rises above the bottom-middle of the scroll viewport, wherever in a long body
 * the passage lies, and withdraws when the selection collapses; its X clears
 * the selection. The footer under the field keeps the one-line echo and Cancel
 * (which leaves selection mode) and, on web, stays pinned to the foot of the
 * viewport (#2952), so there is never a second primary on screen. A surface
 * that passes ``confirmPlacement="footer"`` keeps the older footer confirm: an
 * honestly disabled Button that lights once a passage is chosen, an empty tap
 * surfacing a gentle hint instead.
 *
 * A host can add to the pill (#3660): a Course chapter offers Write a note
 * beside Promote, shows the pill busy while a promote it holds behind a
 * one-time explainer is in flight, and -- staying in selection mode after a
 * promote so the reader keeps their place -- clears the selection once it
 * settles (``clearSelectionKey``).
 *
 * The field trades the browser focus ring for a terracotta rule lit while it
 * holds focus and grows to its text. Shared by the read-mode promote flow on
 * ``JournalEntryScreen``, the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel``, the Course reader's passage selection and a
 * Resonance Letter's;
 * ``testID`` prefixes every element so more than one surface can coexist on a
 * page.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { selectionToAnchorSpan } from './anchorSpan';
import { codePointToUtf16 } from './codePoints';
import FloatingPromoteButton, {
  DEFAULT_PROMOTE_LABEL,
  type FloatingSecondaryAction,
} from './FloatingPromoteButton';
import styles from './JournalEntry.styles';
import { floatingDockStyle, pinnedFooterStyle } from './readingSurfaceStyles';
import { buildSelectionSurfaceCopy } from './selectionSurfaceCopy';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useInitialFieldSelection, useWebSelectionListener } from './webSelectionListener';
import { revealWebOffset } from './webSelectionReveal';

import { Button } from '@/components/Button';
import { editorialType, writingFieldFocus } from '@/design/tokens';

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;
type ContentSizeChangeEvent = NativeSyntheticEvent<TextInputContentSizeChangeEventData>;

/** Body lines the field shows at minimum, so a one-line entry is not boxed in blank page. */
const SELECTION_FIELD_MIN_LINES = 2;

/** The selection field's floor in dp; its text takes over above this. */
export const SELECTION_FIELD_MIN_HEIGHT = SELECTION_FIELD_MIN_LINES * editorialType.body.lineHeight;

/**
 * A selection span in Unicode code-point offsets (the anchor API's unit),
 * end-exclusive, with edge whitespace trimmed. It is produced at the single
 * conversion boundary, ``selectionToAnchorSpan``, between the native TextInput's
 * UTF-16 selection and the code-point anchors both send flows post.
 */
export interface CodePointSpan {
  start: number;
  end: number;
}

/** The raw UTF-16 selection kept locally so the preview can slice ``body``. */
interface Utf16Span {
  start: number;
  end: number;
}

/** Prefix for the surface's testIDs; the read-mode flow relies on this default. */
const DEFAULT_TEST_ID = 'quote-select';

/** The footer's way out, by default: it leaves the promote flow. */
const DEFAULT_CANCEL_LABEL = 'Cancel';
const DEFAULT_CANCEL_A11Y = 'Cancel promoting';

/** How the footer's Cancel reads, and what a screen reader calls it. */
interface CancelNaming {
  label: string;
  accessibilityLabel: string;
}

/** What the host adds to the floating pill beyond its label (#3660). */
interface PillOptions {
  accessibilityLabel?: string;
  secondaryAction?: FloatingSecondaryAction;
  /** The host's own work is in flight: the pill shows busy whatever its press did. */
  busy: boolean;
}

/**
 * Where the surface puts its confirm: on the floating pill that comes to the
 * selection (the default, #3134), or in the footer under the field.
 */
export type ConfirmPlacement = 'floating' | 'footer';

export interface QuoteSelectionSurfaceProps {
  body: string;
  /** Emits the selection as a code-point span (already converted from UTF-16). */
  onSelectionChange: (_span: CodePointSpan) => void;
  /**
   * Act on the chosen passage. It settles rather than rejects (each caller maps
   * its own failures to a hint); the floating confirm is busy until it does.
   */
  onConfirm: () => Promise<void>;
  /** Leave selection mode altogether (the footer's Cancel). */
  onCancel: () => void;
  testID?: string;
  /** Label on the confirm; defaults to the promote-flow wording. */
  confirmLabel?: string;
  /**
   * The floating pill by default; ``'footer'`` keeps the older confirm under
   * the field for a host that still wants it.
   */
  confirmPlacement?: ConfirmPlacement;
  /** The pill's accessible name, when it should say more than its label ("Promote this passage"). */
  confirmAccessibilityLabel?: string;
  /**
   * A quieter second action on the floating pill, beside the confirm: a Course
   * chapter's Write a note (#3660). Floating placement only.
   */
  secondaryAction?: FloatingSecondaryAction;
  /**
   * The host's confirm is still working after ``onConfirm`` settled -- a promote
   * held behind a one-time explainer -- so the pill shows busy until it is not.
   */
  confirmBusy?: boolean;
  /**
   * Collapse the selection whenever this changes after mount (not on mount):
   * a host that stays in selection mode after promoting (the Course reader)
   * moves it on once the promote settles, so the pill and the echo leave with
   * the passage just promoted and the reader keeps their place.
   */
  clearSelectionKey?: number;
  /** The footer Cancel's label; defaults to "Cancel". */
  cancelLabel?: string;
  /** The footer Cancel's accessible name; defaults to "Cancel promoting". */
  cancelAccessibilityLabel?: string;
  /**
   * Cap on the field's height, in dp. Unset (read mode, and the panel on web,
   * whose footer is sticky), the field grows to its text and never scrolls
   * inside. Set (the sources panel on native, where nothing is sticky), a long
   * body scrolls within the field so the actions beneath it stay in the sheet.
   */
  maxFieldHeight?: number;
  /**
   * A passage already chosen before this surface mounted (the sources panel
   * swapping its sheet for its pane mid-selection), so the preview and the
   * enabled confirm carry over. Defaults to nothing chosen.
   */
  initialSelection?: CodePointSpan;
}

/** The derived view state the surface chrome renders from. */
interface SelectionSurfaceState {
  /** The UTF-16 passage chosen before the surface mounted, drawn selected once; null if none. */
  initialSpan: Utf16Span | null;
  isEmpty: boolean;
  previewSlice: string;
  /** The raw selection's UTF-16 end: where clearing the selection collapses it to. */
  selectionEnd: number;
  hintVisible: boolean;
  emitSpan: (_startUtf16: number, _endUtf16: number) => void;
  handleSelectionChange: (_event: SelectionChangeEvent) => void;
  showHint: () => void;
}

/**
 * Own the surface's selection and hint state in one place: hold the raw UTF-16
 * span, emit the trimmed code-point span at the single conversion boundary, and
 * clear the empty-tap hint the moment a real passage is chosen.
 */
function useSelectionSurfaceState(
  body: string,
  onSelectionChange: (_span: CodePointSpan) => void,
  initialSelection?: CodePointSpan,
): SelectionSurfaceState {
  // Held once, so the field is seeded from the span it MOUNTED with and never
  // re-seeded as the writer moves on to another passage.
  const [initialSpan] = useState<Utf16Span | null>(() =>
    initialSelection == null
      ? null
      : {
          start: codePointToUtf16(body, initialSelection.start),
          end: codePointToUtf16(body, initialSelection.end),
        },
  );
  const [span, setSpan] = useState<Utf16Span>(() => initialSpan ?? { start: 0, end: 0 });
  const [hintVisible, setHintVisible] = useState(false);

  const emitSpan = useCallback(
    (startUtf16: number, endUtf16: number) => {
      setSpan({ start: startUtf16, end: endUtf16 });
      const anchor = selectionToAnchorSpan(body, { start: startUtf16, end: endUtf16 });
      onSelectionChange(anchor);
      if (anchor.end > anchor.start) {
        setHintVisible(false);
      }
    },
    [body, onSelectionChange, setSpan, setHintVisible],
  );

  const handleSelectionChange = useCallback(
    (event: SelectionChangeEvent) => {
      const { start, end } = event.nativeEvent.selection;
      emitSpan(start, end);
    },
    [emitSpan],
  );

  const showHint = useCallback(() => setHintVisible(true), [setHintVisible]);

  // Gate emptiness on the span the API actually receives (trimmed, in code
  // points), so the disabled confirm and the posted anchors agree at the same
  // boundary. The preview echoes that same span: exactly what will be stored.
  const anchor = selectionToAnchorSpan(body, span);
  const isEmpty = anchor.end <= anchor.start;
  return {
    initialSpan,
    isEmpty,
    selectionEnd: span.end,
    previewSlice: isEmpty
      ? ''
      : body.slice(codePointToUtf16(body, anchor.start), codePointToUtf16(body, anchor.end)),
    hintVisible,
    emitSpan,
    handleSelectionChange,
    showHint,
  };
}

/** The measured height the field takes, from ``useGrowingFieldHeight``. */
interface FieldGrowth {
  minHeight?: number;
  height?: number;
}

interface SelectionBodyProps {
  body: string;
  onSelectionChange: (_event: SelectionChangeEvent) => void;
  onContentSizeChange: (_event: ContentSizeChangeEvent) => void;
  growth: FieldGrowth;
  inputRef: React.RefObject<TextInput | null>;
  testID: string;
  maxFieldHeight?: number;
}

/**
 * The read-only body field, isolated in ``React.memo`` behind stable handlers
 * and a memoised growth object so preview/hint/confirm state changes re-render
 * only the surrounding chrome, never the mirrored text. It owns its own focus
 * flag for the same reason: lighting the focus rule must not re-render the
 * chrome either.
 */
const SelectionBody = React.memo(function SelectionBody({
  body,
  onSelectionChange,
  onContentSizeChange,
  growth,
  inputRef,
  testID,
  maxFieldHeight,
}: SelectionBodyProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const bounded = maxFieldHeight != null;
  return (
    <TextInput
      ref={inputRef}
      style={[
        styles.quoteSelectField,
        writingFieldFocus,
        growth,
        bounded && { maxHeight: maxFieldHeight },
        focused && styles.quoteSelectFieldFocused,
      ]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      value={body}
      multiline
      editable
      // The control that opened the surface (read mode's Promote button, or the
      // sheet's opener) unmounts as it opens, so focus is handed here rather
      // than dropped on the page; with the soft keyboard suppressed this only
      // lights the focus rule and puts a keyboard reader in the text.
      autoFocus
      showSoftInputOnFocus={false}
      caretHidden
      scrollEnabled={bounded}
      onSelectionChange={onSelectionChange}
      onContentSizeChange={onContentSizeChange}
      accessibilityLabel="Select a passage to promote"
      testID={`${testID}-input`}
    />
  );
});

/**
 * Size the field to its text (no blank-page floor, no inner scroll pane),
 * handing the body a growth object that changes only when the measured height
 * does, so the memoised body is not re-rendered by the chrome.
 */
function useSelectionFieldGrowth(): {
  growth: FieldGrowth;
  onContentSizeChange: (_event: ContentSizeChangeEvent) => void;
} {
  const measured = useGrowingFieldHeight(SELECTION_FIELD_MIN_HEIGHT);
  const { minHeight, height } = measured.style;
  const growth = useMemo<FieldGrowth>(() => ({ minHeight, height }), [minHeight, height]);
  return { growth, onContentSizeChange: measured.onContentSizeChange };
}

/** Leave selection mode: the one decline, in the footer in both placements. */
function CancelControl({
  onCancel,
  testID,
  inline,
  naming,
}: {
  onCancel: () => void;
  testID: string;
  /** True in the floating footer's row, where the label centres on the row's line. */
  inline: boolean;
  naming: CancelNaming;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      onPress={onCancel}
      accessibilityRole="button"
      accessibilityLabel={naming.accessibilityLabel}
      style={styles.quoteActionButton}
      testID={`${testID}-cancel`}
    >
      <Text style={inline ? styles.quoteSelectCancelInline : styles.controlLink}>
        {naming.label}
      </Text>
    </TouchableOpacity>
  );
}

interface SelectionActionsProps {
  isEmpty: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  showHint: () => void;
  testID: string;
  confirmLabel: string;
  cancelNaming: CancelNaming;
}

/**
 * The footer placement's confirm/cancel row. An empty tap lands on the guard (a
 * hint) and ``onConfirm`` never fires on an empty span. The guard loses its
 * handler once the Button enables; it must not become a disabled ancestor,
 * because web accessibility semantics would then disable the enabled
 * descendant too.
 */
function SelectionActions({
  isEmpty,
  onConfirm,
  onCancel,
  showHint,
  testID,
  confirmLabel,
  cancelNaming,
}: SelectionActionsProps): React.JSX.Element {
  return (
    <View style={styles.quoteSelectActions}>
      <Pressable
        accessible={false}
        onPress={isEmpty ? showHint : undefined}
        testID={`${testID}-confirm-guard`}
      >
        <Button
          variant="primary"
          label={confirmLabel}
          disabled={isEmpty}
          onPress={() => void onConfirm()}
          testID={`${testID}-confirm`}
        />
      </Pressable>
      <CancelControl onCancel={onCancel} testID={testID} inline={false} naming={cancelNaming} />
    </View>
  );
}

/** The highlighted card echoing the chosen passage back before it is promoted. */
function PreviewCard({
  previewSlice,
  testID,
  inline,
}: {
  previewSlice: string;
  testID: string;
  /** True in the floating footer's row: one line, sharing the row with Cancel. */
  inline: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.quoteSelectPreview, inline && styles.quoteSelectPreviewInline]}>
      <Text
        style={styles.quoteSelectPreviewText}
        numberOfLines={inline ? 1 : undefined}
        testID={`${testID}-preview`}
      >
        {previewSlice}
      </Text>
    </View>
  );
}

/**
 * One opaque plate that web pins to the foot of the scroll viewport, so a
 * reader deep in a long body always has the echo and the way out in view.
 */
function SelectionFooter({
  testID,
  children,
}: {
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.quoteSelectFooter, pinnedFooterStyle]} testID={`${testID}-footer`}>
      {children}
    </View>
  );
}

/**
 * The floating placement's footer: the echo and Cancel on one row, the echo
 * held to a single line so the plate stays under the floating pill's lift.
 * Before a passage is chosen a spacer holds Cancel on the same trailing edge.
 */
function FloatingFooterRow({
  previewSlice,
  onCancel,
  testID,
  cancelNaming,
}: {
  previewSlice: string;
  onCancel: () => void;
  testID: string;
  cancelNaming: CancelNaming;
}): React.JSX.Element {
  return (
    <View style={styles.quoteSelectFooterRow} testID={`${testID}-footer-row`}>
      {previewSlice === '' ? (
        <View style={styles.quoteSelectFooterSpacer} />
      ) : (
        <PreviewCard previewSlice={previewSlice} testID={testID} inline />
      )}
      <CancelControl onCancel={onCancel} testID={testID} inline naming={cancelNaming} />
    </View>
  );
}

/** The selection-moving method each platform's host field exposes, when it does. */
interface CollapsibleField {
  /** React Native's TextInput (iOS / Android). */
  setSelection?: (_start: number, _end: number) => void;
  /** The DOM textarea react-native-web renders. */
  setSelectionRange?: (_start: number, _end: number) => void;
}

/** Collapse the field's own selection to a caret at ``at`` (UTF-16). */
function collapseFieldSelection(node: TextInput | null, at: number): void {
  const field = node as unknown as CollapsibleField | null;
  if (Platform.OS === 'web') {
    field?.setSelectionRange?.(at, at);
  } else {
    field?.setSelection?.(at, at);
  }
}

/**
 * Bring a passage chosen before the surface opened into view, once (#3660).
 *
 * The field grows to its text and never scrolls inside, so a Course quote's
 * Open, landing on a chapter screens long, would show the passage selected but
 * out of sight. So once the field has grown past its floor -- before that, the
 * page is not yet tall enough to scroll there -- the page is scrolled to it,
 * on the web (``revealWebOffset``; native's reader scroll is the field's own).
 * Once: a reader who scrolls away from it is never pulled back.
 */
function useRevealInitialSelection(
  inputRef: React.RefObject<TextInput | null>,
  initialSpan: Utf16Span | null,
  fieldHeight: number | undefined,
): void {
  const revealed = useRef(false);
  const grown = fieldHeight !== undefined && fieldHeight > SELECTION_FIELD_MIN_HEIGHT;
  useEffect(() => {
    if (revealed.current || initialSpan === null || initialSpan.end <= initialSpan.start) {
      return undefined;
    }
    if (!grown) return undefined;
    // A frame later, so the grown height has been laid out before it is scrolled.
    const frame = requestAnimationFrame(() => {
      revealed.current = true;
      revealWebOffset(inputRef.current, initialSpan.start);
    });
    return () => cancelAnimationFrame(frame);
  }, [inputRef, initialSpan, grown]);
}

/**
 * Collapse the field's own selection too, so the highlight and the pill leave
 * together, then hand focus back to the text -- the control that asked (the
 * pill's X, or its primary once a host's promote settles) is about to leave.
 */
function useCollapseSelection(
  inputRef: React.RefObject<TextInput | null>,
  selectionEnd: number,
  emitSpan: (_startUtf16: number, _endUtf16: number) => void,
): () => void {
  return useCallback(() => {
    collapseFieldSelection(inputRef.current, selectionEnd);
    emitSpan(selectionEnd, selectionEnd);
    inputRef.current?.focus();
  }, [emitSpan, inputRef, selectionEnd]);
}

/**
 * Collapse the selection each time ``key`` moves on after mount. The key the
 * surface mounted with is remembered, not acted on, so opening on a seeded
 * passage never clears it.
 */
function useClearOnKey(key: number | undefined, collapse: () => void): void {
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    collapse();
  }, [key, collapse]);
}

interface FloatingConfirmProps {
  isEmpty: boolean;
  collapse: () => void;
  onConfirm: () => Promise<void>;
  confirmLabel: string;
  pill: PillOptions;
}

/** The floating confirm's press handler and its in-flight flag. */
function useFloatingConfirm(onConfirm: () => Promise<void>): {
  confirming: boolean;
  confirm: () => void;
} {
  const [confirming, setConfirming] = useState(false);
  // A ref, not the state above: two presses in one frame both read it before
  // either re-render lands, so a double tap still posts once.
  const inFlight = useRef(false);

  const confirm = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirming(true);
    // ``finally``: the guard lifts whichever way the work settles, and a
    // rejection (a caller breaking the settle-not-reject contract) still
    // surfaces rather than being swallowed here.
    void onConfirm().finally(() => {
      inFlight.current = false;
      setConfirming(false);
    });
  }, [onConfirm]);

  return { confirming, confirm };
}

/**
 * The dock the floating pill rides in, the last thing in the surface: pinned
 * to the foot of the scroll viewport on web and spanning the surface on
 * native (``floatingDockStyle``). ``box-none`` keeps the text beneath it
 * selectable.
 */
function FloatingConfirm({
  isEmpty,
  collapse,
  onConfirm,
  confirmLabel,
  pill,
  testID,
}: FloatingConfirmProps & { testID: string }): React.JSX.Element {
  const { confirming, confirm } = useFloatingConfirm(onConfirm);
  return (
    <View style={floatingDockStyle} pointerEvents="box-none" testID={`${testID}-dock`}>
      <FloatingPromoteButton
        visible={!isEmpty}
        label={confirmLabel}
        accessibilityLabel={pill.accessibilityLabel}
        secondaryAction={pill.secondaryAction}
        onPress={confirm}
        onCancel={collapse}
        busy={confirming || pill.busy}
      />
    </View>
  );
}

interface SelectionActionsAreaProps {
  state: SelectionSurfaceState;
  floating: boolean;
  collapse: () => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID: string;
  confirmLabel: string;
  pill: PillOptions;
  cancelNaming: CancelNaming;
}

/**
 * Everything after the field: the pinned footer, and -- in the floating
 * placement -- the band the pill rests in at the text's end, before the
 * footer, and the dock it rides in, last so it paints over the rest.
 */
function SelectionActionsArea({
  state,
  floating,
  collapse,
  onConfirm,
  onCancel,
  testID,
  confirmLabel,
  pill,
  cancelNaming,
}: SelectionActionsAreaProps): React.JSX.Element {
  return (
    <>
      {floating ? (
        <View style={styles.quoteSelectPillReserve} testID={`${testID}-pill-reserve`} />
      ) : null}
      <SelectionFooter testID={testID}>
        {floating ? (
          <FloatingFooterRow
            previewSlice={state.previewSlice}
            onCancel={onCancel}
            testID={testID}
            cancelNaming={cancelNaming}
          />
        ) : (
          <FooterConfirm
            state={state}
            emptyHint={buildSelectionSurfaceCopy(Platform.OS).emptyHint}
            onConfirm={onConfirm}
            onCancel={onCancel}
            testID={testID}
            confirmLabel={confirmLabel}
            cancelNaming={cancelNaming}
          />
        )}
      </SelectionFooter>
      {floating ? (
        <FloatingConfirm
          isEmpty={state.isEmpty}
          collapse={collapse}
          onConfirm={onConfirm}
          confirmLabel={confirmLabel}
          pill={pill}
          testID={testID}
        />
      ) : null}
    </>
  );
}

/**
 * The warm guiding line above the field. Its wording is resolved per render
 * rather than at module load so it follows the platform the surface is
 * actually mounted on (and so a test that sets ``Platform.OS`` after import
 * sees the copy change); the footer's empty-tap hint is resolved the same way.
 */
function SelectionInstruction({ testID }: { testID: string }): React.JSX.Element {
  return (
    <Text style={styles.quoteSelectInstruction} testID={`${testID}-instruction`}>
      {buildSelectionSurfaceCopy(Platform.OS).instruction}
    </Text>
  );
}

/** The host's additions to the pill and the footer Cancel, memoised so the chrome re-renders only when they change. */
function useHostChrome({
  confirmAccessibilityLabel,
  secondaryAction,
  confirmBusy = false,
  cancelLabel = DEFAULT_CANCEL_LABEL,
  cancelAccessibilityLabel = DEFAULT_CANCEL_A11Y,
}: Pick<
  QuoteSelectionSurfaceProps,
  | 'confirmAccessibilityLabel'
  | 'secondaryAction'
  | 'confirmBusy'
  | 'cancelLabel'
  | 'cancelAccessibilityLabel'
>): { pill: PillOptions; cancelNaming: CancelNaming } {
  const pill = useMemo<PillOptions>(
    () => ({ accessibilityLabel: confirmAccessibilityLabel, secondaryAction, busy: confirmBusy }),
    [confirmAccessibilityLabel, secondaryAction, confirmBusy],
  );
  const cancelNaming = useMemo<CancelNaming>(
    () => ({ label: cancelLabel, accessibilityLabel: cancelAccessibilityLabel }),
    [cancelLabel, cancelAccessibilityLabel],
  );
  return { pill, cancelNaming };
}

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
  confirmLabel = DEFAULT_PROMOTE_LABEL,
  confirmPlacement = 'floating',
  clearSelectionKey,
  maxFieldHeight,
  initialSelection,
  ...host
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  const state = useSelectionSurfaceState(body, onSelectionChange, initialSelection);
  const inputRef = useRef<TextInput>(null);
  useWebSelectionListener(inputRef, state.emitSpan);
  useInitialFieldSelection(inputRef, state.initialSpan);
  const { growth, onContentSizeChange } = useSelectionFieldGrowth();
  useRevealInitialSelection(inputRef, state.initialSpan, growth.height);
  const collapse = useCollapseSelection(inputRef, state.selectionEnd, state.emitSpan);
  useClearOnKey(clearSelectionKey, collapse);
  const { pill, cancelNaming } = useHostChrome(host);

  return (
    <View>
      <SelectionInstruction testID={testID} />
      <SelectionBody
        body={body}
        onSelectionChange={state.handleSelectionChange}
        onContentSizeChange={onContentSizeChange}
        growth={growth}
        inputRef={inputRef}
        testID={testID}
        maxFieldHeight={maxFieldHeight}
      />
      <SelectionActionsArea
        state={state}
        floating={confirmPlacement === 'floating'}
        collapse={collapse}
        onConfirm={onConfirm}
        onCancel={onCancel}
        testID={testID}
        confirmLabel={confirmLabel}
        pill={pill}
        cancelNaming={cancelNaming}
      />
    </View>
  );
}

/** The footer placement's contents: the preview card, the action row and the empty-tap hint. */
function FooterConfirm({
  state,
  emptyHint,
  onConfirm,
  onCancel,
  testID,
  confirmLabel,
  cancelNaming,
}: {
  state: SelectionSurfaceState;
  emptyHint: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID: string;
  confirmLabel: string;
  cancelNaming: CancelNaming;
}): React.JSX.Element {
  return (
    <>
      {state.previewSlice === '' ? null : (
        <PreviewCard previewSlice={state.previewSlice} testID={testID} inline={false} />
      )}
      <SelectionActions
        isEmpty={state.isEmpty}
        onConfirm={onConfirm}
        onCancel={onCancel}
        showHint={state.showHint}
        testID={testID}
        confirmLabel={confirmLabel}
        cancelNaming={cancelNaming}
      />
      {state.hintVisible ? (
        <Text style={styles.quoteSelectHint} testID={`${testID}-hint`}>
          {emptyHint}
        </Text>
      ) : null}
    </>
  );
}

export default QuoteSelectionSurface;
