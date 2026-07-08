/**
 * Shared load/error presentational blocks for the Practice surfaces.
 *
 * `LoadingBlock` wraps an `ActivityIndicator` in a styled container; the caller
 * chooses whether the container or the spinner carries the testID. `LoadErrorRetry`
 * renders an error message with an optional Retry button — the button only appears
 * when `onRetry` is supplied, matching the call sites that render a retry only on
 * a retryable failure.
 */
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

const RETRY_LABEL = 'Retry';

interface LoadingBlockProps {
  style: StyleProp<ViewStyle>;
  color: string;
  size?: 'small' | 'large';
  testID?: string;
  spinnerTestID?: string;
}

/** A centered spinner in a styled container; testID may sit on either node. */
export function LoadingBlock({
  style,
  color,
  size,
  testID,
  spinnerTestID,
}: LoadingBlockProps): React.JSX.Element {
  return (
    <View style={style} testID={testID}>
      <ActivityIndicator color={color} size={size} testID={spinnerTestID} />
    </View>
  );
}

interface LoadErrorRetryProps {
  message: string;
  onRetry?: () => void;
  containerStyle: StyleProp<ViewStyle>;
  containerTestID?: string;
  messageStyle: StyleProp<TextStyle>;
  retryStyle: StyleProp<ViewStyle>;
  retryTextStyle: StyleProp<TextStyle>;
  retryTestID: string;
  retryAccessibilityLabel?: string;
}

/** An error message with an optional Retry button (rendered only when `onRetry`). */
export function LoadErrorRetry({
  message,
  onRetry,
  containerStyle,
  containerTestID,
  messageStyle,
  retryStyle,
  retryTextStyle,
  retryTestID,
  retryAccessibilityLabel,
}: LoadErrorRetryProps): React.JSX.Element {
  return (
    <View style={containerStyle} testID={containerTestID}>
      <Text style={messageStyle}>{message}</Text>
      {onRetry ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={retryAccessibilityLabel}
          onPress={onRetry}
          style={retryStyle}
          testID={retryTestID}
        >
          <Text style={retryTextStyle}>{RETRY_LABEL}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
