import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

import styles from './Course.styles';

export const RETRY_LABEL = 'Try again';

interface RetryButtonProps {
  onRetry: () => void;
  testID?: string;
}

const RetryButton = ({ onRetry, testID }: RetryButtonProps): React.JSX.Element => (
  <TouchableOpacity
    onPress={onRetry}
    accessibilityRole="button"
    accessibilityLabel={RETRY_LABEL}
    style={styles.retryButton}
    testID={testID}
  >
    <Text style={styles.buttonLabelOnAccent}>{RETRY_LABEL}</Text>
  </TouchableOpacity>
);

export default RetryButton;
