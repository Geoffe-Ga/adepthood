/**
 * ``JournalModalShell`` — the shared scrim/card modal shell for the Journal
 * feature. Dims the still-visible page, dismisses on a scrim tap, and captures
 * taps on the centred card so they don't bubble to the scrim. Callers supply the
 * card's body and any extra card style (e.g. a maxHeight cap).
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

export interface JournalModalShellProps {
  visible: boolean;
  onDismiss: () => void;
  scrimTestID: string;
  scrimLabel: string;
  modalTestID?: string;
  cardTestID?: string;
  cardStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** Stable no-op so the card's tap-capture doesn't allocate a fn per render. */
const NOOP = (): void => {};

function JournalModalShell({
  visible,
  onDismiss,
  scrimTestID,
  scrimLabel,
  modalTestID,
  cardTestID,
  cardStyle,
  children,
}: JournalModalShellProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      testID={modalTestID}
    >
      <Pressable
        style={styles.scrim}
        onPress={onDismiss}
        testID={scrimTestID}
        accessibilityLabel={scrimLabel}
      >
        <Pressable style={[styles.card, cardStyle]} onPress={NOOP} testID={cardTestID}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  card: {
    padding: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: colors.paper.background,
  },
});

export default JournalModalShell;
