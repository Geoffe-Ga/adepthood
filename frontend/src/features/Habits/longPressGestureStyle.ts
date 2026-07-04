import { Platform, type ViewStyle } from 'react-native';

type LongPressPlatform = typeof Platform.OS;

export type WebLongPressStyle = ViewStyle & {
  userSelect?: 'none';
  WebkitUserSelect?: 'none';
  WebkitTouchCallout?: 'none';
  touchAction?: 'manipulation';
};

/**
 * Browser defaults turn long-press into text selection and callouts (the iOS
 * Safari loupe is the painful one). Habit stars use long-press as the primary
 * progress-logging gesture, so web targets opt out of those browser gestures.
 */
export const buildLongPressGestureStyle = (platform: LongPressPlatform): WebLongPressStyle =>
  platform === 'web'
    ? {
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'manipulation',
      }
    : {};

export const longPressGestureStyle = buildLongPressGestureStyle(Platform.OS);
