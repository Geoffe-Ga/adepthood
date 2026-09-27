import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Speak `text` on iOS.
 *
 * Callers mark their status lines as live regions (the feedback composer's
 * status, the journal's "Promoted" notice), which is how Android
 * (`accessibilityLiveRegion`) and the web (`aria-live`) announce them.
 * iOS honours neither: VoiceOver says nothing when a live region changes, and
 * the `alert` role posts no announcement. So on iOS the same text is posted
 * explicitly -- and only there, so Android and web users do not hear it twice.
 */
export function announceOnIos(text: string): void {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
}
