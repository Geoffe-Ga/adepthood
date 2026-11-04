/**
 * ``RenderedSelectionPill`` -- #3134's floating pill over a passage the reader
 * highlighted right on the rendered page (#3661). Web only.
 *
 * It rides the dock the selection field's pill rides (``floatingDockStyle``: a
 * zero-height sticky strip at the foot of the scroll viewport, spanning the
 * text column), so it sits exactly where that pill sits and settles in and out
 * with the same fade. The host follows the passage (``useHighlightedPassage``),
 * places this last in the column it reads, and says what Promote does with it.
 *
 * What the rendered page adds to that pill:
 *
 * - The passage is the document's own selection, and a mouse press anywhere
 *   collapses it by default -- taking the pill, and its click, with it before
 *   the press lands. So the dock declines a mouse press's default action,
 *   which is what moves the selection; the press itself still reaches the
 *   pill. Its X lets go of the selection.
 * - A band the height of the pill's lift is kept clear above the dock, under
 *   the surface's last row: its "Promote a quote" opener, a touch target tall.
 *   At a text's end the pill therefore rests on that row -- the opener stepping
 *   aside for it (``STEP_ASIDE``) -- never on the last line, and a passage the
 *   pill would cover can always be lifted clear of it (``useLiftClearOfPill``).
 *   The band is always there, not only while a passage is chosen: one that
 *   came and went would move a centred card, and the words in it, under the
 *   reader's hand.
 *
 * Off the web there is no rendered selection to follow (native keeps the
 * tap-to-select surface), so it draws nothing at all.
 */
import React, { useCallback, useRef } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import type { AnchorSpan } from './anchorSpan';
import FloatingPromoteButton, {
  FLOATING_PROMOTE_TEST_ID,
  type FloatingPromoteButtonProps,
} from './FloatingPromoteButton';
import { RESONANCE_BUTTON_CLEARANCE } from './JournalEntry.styles';
import { floatingDockStyle } from './readingSurfaceStyles';
import { clearRenderedSelection } from './useRenderedSelection';
import { useLiftClearOfPill } from './webSelectionLift';

/** The part of a DOM mouse event the dock acts on. */
interface MouseDownEvent {
  preventDefault: () => void;
}

// react-native-web forwards ``onMouseDown`` to the DOM; React Native's public
// ViewProps omit it.
type DockProps = React.ComponentPropsWithRef<typeof View> & {
  onMouseDown?: (_event: MouseDownEvent) => void;
};
const Dock = View as React.ComponentType<DockProps>;

/** A mouse press on the pill must not collapse the passage it is about to act on. */
function keepSelection(event: MouseDownEvent): void {
  event.preventDefault();
}

/**
 * A "Promote a quote" opener while the pill stands in for it: kept in its
 * place, so nothing reflows, but unseen. The host also makes it inert and
 * hides it from assistive technology for as long as a passage is chosen.
 */
export const STEP_ASIDE: ViewStyle = Object.freeze({ opacity: 0 });

export interface RenderedSelectionPillProps extends Omit<
  FloatingPromoteButtonProps,
  'visible' | 'onPress'
> {
  /** The passage highlighted on the page, as a span of the source; null while none is. */
  passage: AnchorSpan | null;
  /** Promote ``passage`` (behind the host's one-time note). */
  onPromote: (_span: AnchorSpan) => void;
  /**
   * The band kept under the surface, in dp. Defaults to the pill's lift, which
   * with a row of controls (a touch target) above it clears a text's end; a
   * surface whose text ends with no such row (a Course chapter) keeps the whole
   * pill and its breath as well.
   */
  reserve?: number;
}

function RenderedSelectionPill({
  passage,
  onPromote,
  onCancel = clearRenderedSelection,
  testID = FLOATING_PROMOTE_TEST_ID,
  reserve = RESONANCE_BUTTON_CLEARANCE,
  ...pill
}: RenderedSelectionPillProps): React.JSX.Element | null {
  const dockRef = useRef<View>(null);
  useLiftClearOfPill(dockRef, passage);
  const onPress = useCallback(() => {
    if (passage !== null) onPromote(passage);
  }, [passage, onPromote]);
  if (Platform.OS !== 'web') return null;
  return (
    <>
      <View style={{ height: reserve }} testID={`${testID}-band`} />
      <Dock
        ref={dockRef}
        style={floatingDockStyle}
        pointerEvents="box-none"
        onMouseDown={keepSelection}
        testID={`${testID}-dock`}
      >
        <FloatingPromoteButton
          {...pill}
          visible={passage !== null}
          onPress={onPress}
          onCancel={onCancel}
          testID={testID}
        />
      </Dock>
    </>
  );
}

export default RenderedSelectionPill;
