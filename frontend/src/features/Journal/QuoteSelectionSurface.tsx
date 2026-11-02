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
 * The field trades the browser focus ring for a terracotta rule lit while it
 * holds focus and grows to its text. Shared by the read-mode promote flow on
 * ``JournalEntryScreen``, the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel`` and the Course reader's passage selection;
 * ``testID`` prefixes every element so more than one surface can coexist on a
 * page.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import FloatingPromoteButton, { DEFAULT_PROMOTE_LABEL } from './FloatingPromoteButton';
import styles from './JournalEntry.styles';
import { floatingDockStyle, pinnedFooterStyle } from './readingSurfaceStyles';
import { buildSelectionSurfaceCopy } from './selectionSurfaceCopy';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useWebSelectionListener } from './webSelectionListener';

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
   * The floating pill by default. The Course reader keeps its footer confirm
   * until its own move onto the pill (#3660).
   */
  confirmPlacement?: ConfirmPlacement;
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
  const [span, setSpan] = useState<Utf16Span>(() =>
    initialSelection == null
      ? { start: 0, end: 0 }
      : {
          start: codePointToUtf16(body, initialSelection.start),
          end: codePointToUtf16(body, initialSelection.end),
        },
  );
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
}: {
  onCancel: () => void;
  testID: string;
  /** True in the floating footer's row, where the label centres on the row's line. */
  inline: boolean;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      onPress={onCancel}
      accessibilityRole="button"
      accessibilityLabel="Cancel promoting"
      style={styles.quoteActionButton}
      testID={`${testID}-cancel`}
    >
      <Text style={inline ? styles.quoteSelectCancelInline : styles.controlLink}>Cancel</Text>
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
      <CancelControl onCancel={onCancel} testID={testID} inline={false} />
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
}: {
  previewSlice: string;
  onCancel: () => void;
  testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.quoteSelectFooterRow} testID={`${testID}-footer-row`}>
      {previewSlice === '' ? (
        <View style={styles.quoteSelectFooterSpacer} />
      ) : (
        <PreviewCard previewSlice={previewSlice} testID={testID} inline />
      )}
      <CancelControl onCancel={onCancel} testID={testID} inline />
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

interface FloatingConfirmProps {
  isEmpty: boolean;
  selectionEnd: number;
  emitSpan: (_startUtf16: number, _endUtf16: number) => void;
  inputRef: React.RefObject<TextInput | null>;
  onConfirm: () => Promise<void>;
  confirmLabel: string;
  testID: string;
}

/** The floating confirm's press handlers and its in-flight flag. */
function useFloatingConfirm({
  selectionEnd,
  emitSpan,
  inputRef,
  onConfirm,
}: FloatingConfirmProps): { confirming: boolean; confirm: () => void; clear: () => void } {
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

  // Collapse the field's own selection too, so the highlight and the pill
  // leave together, then hand focus back to the text the X is leaving.
  const clear = useCallback(() => {
    collapseFieldSelection(inputRef.current, selectionEnd);
    emitSpan(selectionEnd, selectionEnd);
    inputRef.current?.focus();
  }, [emitSpan, inputRef, selectionEnd]);

  return { confirming, confirm, clear };
}

/**
 * The dock the floating pill rides in, the last thing in the surface: pinned
 * to the foot of the scroll viewport on web and spanning the surface on
 * native (``floatingDockStyle``). ``box-none`` keeps the text beneath it
 * selectable.
 */
function FloatingConfirm(props: FloatingConfirmProps): React.JSX.Element {
  const { confirming, confirm, clear } = useFloatingConfirm(props);
  return (
    <View style={floatingDockStyle} pointerEvents="box-none" testID={`${props.testID}-dock`}>
      <FloatingPromoteButton
        visible={!props.isEmpty}
        label={props.confirmLabel}
        onPress={confirm}
        onCancel={clear}
        busy={confirming}
      />
    </View>
  );
}

interface SelectionActionsAreaProps {
  state: SelectionSurfaceState;
  floating: boolean;
  inputRef: React.RefObject<TextInput | null>;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID: string;
  confirmLabel: string;
}

/**
 * Everything after the field: the pinned footer, and -- in the floating
 * placement -- the band the pill rests in at the text's end, before the
 * footer, and the dock it rides in, last so it paints over the rest.
 */
function SelectionActionsArea({
  state,
  floating,
  inputRef,
  onConfirm,
  onCancel,
  testID,
  confirmLabel,
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
          />
        ) : (
          <FooterConfirm
            state={state}
            emptyHint={buildSelectionSurfaceCopy(Platform.OS).emptyHint}
            onConfirm={onConfirm}
            onCancel={onCancel}
            testID={testID}
            confirmLabel={confirmLabel}
          />
        )}
      </SelectionFooter>
      {floating ? (
        <FloatingConfirm
          isEmpty={state.isEmpty}
          selectionEnd={state.selectionEnd}
          emitSpan={state.emitSpan}
          inputRef={inputRef}
          onConfirm={onConfirm}
          confirmLabel={confirmLabel}
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

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
  confirmLabel = DEFAULT_PROMOTE_LABEL,
  confirmPlacement = 'floating',
  maxFieldHeight,
  initialSelection,
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  const state = useSelectionSurfaceState(body, onSelectionChange, initialSelection);
  const inputRef = useRef<TextInput>(null);
  useWebSelectionListener(inputRef, state.emitSpan);
  const { growth, onContentSizeChange } = useSelectionFieldGrowth();

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
        inputRef={inputRef}
        onConfirm={onConfirm}
        onCancel={onCancel}
        testID={testID}
        confirmLabel={confirmLabel}
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
}: {
  state: SelectionSurfaceState;
  emptyHint: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID: string;
  confirmLabel: string;
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
