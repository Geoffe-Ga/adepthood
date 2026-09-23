import type React from 'react';
import type { View } from 'react-native';

import type { FeedbackControlToken } from './feedbackControlTokens';
import { rememberFeedbackOrigin } from './feedbackFocus';

/** The one navigation shape every entry point uses to open the composer. */
export interface FeedbackNavigator {
  navigate: (route: 'Feedback', params: { control: FeedbackControlToken }) => void;
}

/**
 * Open the composer from `control`. Only the stable token rides as a param --
 * never anything visible on the screen being left -- and the pressed control is
 * remembered so closing the composer can hand focus back to it.
 */
export function openFeedbackComposer(
  navigation: FeedbackNavigator,
  control: FeedbackControlToken,
  origin: React.RefObject<View | null> | null = null,
): void {
  rememberFeedbackOrigin(origin);
  navigation.navigate('Feedback', { control });
}
