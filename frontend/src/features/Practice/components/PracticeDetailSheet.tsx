/**
 * `PracticeDetailSheet` — a practice's details, opened in place over the
 * Practice tab's embedded catalog (#2451).
 *
 * Tapping a catalog row used to push the `PracticeDetail` route, and an assign
 * there popped back to the top, so the catalog the person had narrowed down
 * (stage, mode, search, scroll) was gone either way. Here the details float
 * over the catalog instead: the catalog stays mounted underneath, so declining
 * the details leaves it exactly as it was. Choosing the practice closes the
 * sheet and hands control to the host (which flips to the player).
 *
 * The body is the route's own view (`usePracticeDetailController` +
 * `PracticeDetailContent`), not a second implementation; only the frame
 * differs. The view's dialogs (copy-to-stage, share) are Modals themselves, so
 * they mount BESIDE this sheet's Modal, never inside it: iOS presents a nested
 * modal underneath its parent, hiding it (the `ReorderHabitsModal` precedent).
 *
 * Dismissal is the corner X (DESIGN.md action rows, rule a), a press on the
 * scrim, and the Modal's `onRequestClose` — which carries Escape on the web
 * and the hardware back button on Android. Focus goes back to the row that
 * opened the sheet. The slide is motion, so it is skipped under reduced motion.
 *
 * The sheet is not a route, so the browser's back button leaves the tab rather
 * than closing it; that is an accepted limitation, not an oversight.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { decorativeHidden } from '@/components/a11yHidden';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  contentLayout,
  surface,
  surfaceShadow,
} from '@/design/tokens';
import ReflectionDismiss, { closeCornerReserve } from '@/features/Journal/ReflectionDismiss';
import {
  PracticeDetailContent,
  PracticeDetailDialogs,
  usePracticeDetailController,
  type CustomizeCopyParams,
} from '@/features/Practice/screens/PracticeDetailScreen';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useRestoreFocusOnClose } from '@/hooks/useRestoreFocusOnClose';

/** The share of the window's height the sheet may take; the rest stays scrim. */
export const DETAIL_SHEET_MAX_HEIGHT_FRACTION = 0.85;

/** The accessible name of both ways out that are not a key press. */
export const CLOSE_DETAIL_LABEL = 'Close practice details';

export interface PracticeDetailSheetProps {
  /** The practice on show, or ``null`` while the sheet is closed. */
  practiceId: number | null;
  /** Declines the details: the X, the scrim, Escape, Android back. */
  onClose: () => void;
  /** Runs after an assign or a cross-stage copy succeeds from the sheet. */
  onAssigned: () => void;
  /** "Duplicate & edit": the host closes the sheet and opens the wizard. */
  onCustomizeCopy: (params: CustomizeCopyParams) => void;
  /** The control that opened the sheet, given focus back when it closes. */
  restoreFocusTo: React.RefObject<{ focus: () => void } | null>;
}

export default function PracticeDetailSheet({
  practiceId,
  onClose,
  onAssigned,
  onCustomizeCopy,
  restoreFocusTo,
}: PracticeDetailSheetProps): React.JSX.Element | null {
  useRestoreFocusOnClose(practiceId !== null, restoreFocusTo);
  if (practiceId === null) return null;
  // Keyed on the practice so every open starts fresh: no stale practice,
  // action error, or open picker carries over from the last one.
  return (
    <SheetBody
      key={practiceId}
      practiceId={practiceId}
      onClose={onClose}
      onAssigned={onAssigned}
      onCustomizeCopy={onCustomizeCopy}
    />
  );
}

type SheetBodyProps = Omit<PracticeDetailSheetProps, 'practiceId' | 'restoreFocusTo'> & {
  practiceId: number;
};

function SheetBody({
  practiceId,
  onClose,
  onAssigned,
  onCustomizeCopy,
}: SheetBodyProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const controller = usePracticeDetailController({ practiceId, onAssigned, onCustomizeCopy });
  return (
    <>
      <Modal
        visible
        transparent
        animationType={reduced ? 'none' : 'slide'}
        onRequestClose={onClose}
      >
        <View style={styles.backdrop}>
          {/* The scrim duplicates the X for pointer users; assistive tech and
              the keyboard use the X and Escape, so it stays out of both. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            focusable={false}
            testID="practice-detail-overlay-scrim"
            {...decorativeHidden()}
          />
          <View
            style={[styles.card, { maxHeight: height * DETAIL_SHEET_MAX_HEIGHT_FRACTION }]}
            accessibilityViewIsModal
            testID="practice-detail-overlay"
          >
            <View style={styles.content}>
              <PracticeDetailContent controller={controller} frame="sheet" />
            </View>
            <ReflectionDismiss
              variant="close"
              accessibilityLabel={CLOSE_DETAIL_LABEL}
              onPress={onClose}
              testID="practice-detail-overlay-close"
            />
          </View>
        </View>
      </Modal>
      <PracticeDetailDialogs controller={controller} />
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.mystical.overlay,
  },
  // The paper ground the detail's raised blocks are designed to sit on.
  card: {
    width: '100%',
    maxWidth: contentLayout.maxWidth,
    alignSelf: 'center',
    backgroundColor: surface.canvas,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    ...surfaceShadow.raised,
  },
  // Keeps the heading and badges clear of the corner X.
  content: { flexShrink: 1, paddingRight: closeCornerReserve(SPACING.lg) },
});
