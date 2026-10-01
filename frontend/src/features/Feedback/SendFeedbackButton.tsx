import { MessageSquare } from 'lucide-react-native';
import React, { useCallback, useRef } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { SEND_FEEDBACK_COMPACT_LABEL, SEND_FEEDBACK_LABEL } from './feedbackCopy';
import { FEEDBACK_TEST_IDS } from './feedbackTestIds';

import { decorativeHidden } from '@/components/a11yHidden';
import { Button } from '@/components/Button';
import { accent, breakpoints, SPACING, touchTarget } from '@/design/tokens';

const ICON_SIZE = 18;

/** Test hook for the header button's icon wrapper, which assistive tech skips. */
export const SEND_FEEDBACK_ICON_TEST_ID = 'send-feedback-icon';

interface SendFeedbackButtonProps {
  /** Called with the button's own ref, so the composer can hand focus back to it. */
  onPress: (origin: React.RefObject<View | null>) => void;
}

/**
 * The "Send feedback" control in the app shell's header, beside the Settings
 * gear, on every tab.
 *
 * A tertiary (text-only) button so it stays quieter than whatever the screen
 * is for. Below the `md` breakpoint the visible label shortens to "Feedback" so
 * it fits beside a tab title on a phone; its accessible name is "Send feedback"
 * at every width.
 */
export function SendFeedbackButton({ onPress }: SendFeedbackButtonProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const ref = useRef<View>(null);
  const compact = width < breakpoints.md;
  const handlePress = useCallback(() => onPress(ref), [onPress]);
  return (
    <Button
      ref={ref}
      label={compact ? SEND_FEEDBACK_COMPACT_LABEL : SEND_FEEDBACK_LABEL}
      accessibilityLabel={SEND_FEEDBACK_LABEL}
      variant="tertiary"
      onPress={handlePress}
      testID={FEEDBACK_TEST_IDS.headerButton}
      style={styles.button}
      icon={
        <View style={styles.icon} {...decorativeHidden()} testID={SEND_FEEDBACK_ICON_TEST_ID}>
          <MessageSquare color={accent.primary} size={ICON_SIZE} />
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  icon: { marginRight: SPACING.xs },
});
