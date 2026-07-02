import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { SPACING, colors } from '@/design/tokens';

/**
 * Shared error/status banner for Settings form screens.
 *
 * Renders the error message when present, otherwise the success status,
 * otherwise nothing. The ``idPrefix`` keeps each screen's distinct testIDs
 * (``api-key-error``/``api-key-status`` vs ``timezone-error``/``timezone-status``)
 * from a single style + markup definition.
 */

interface SettingsFeedbackBannerProps {
  idPrefix: string;
  error: string | null;
  status: string | null;
}

export const SettingsFeedbackBanner = ({
  idPrefix,
  error,
  status,
}: SettingsFeedbackBannerProps): React.JSX.Element | null => {
  if (error) {
    return (
      <Text style={styles.error} testID={`${idPrefix}-error`}>
        {error}
      </Text>
    );
  }
  if (status) {
    return (
      <Text style={styles.success} testID={`${idPrefix}-status`}>
        {status}
      </Text>
    );
  }
  return null;
};

const styles = StyleSheet.create({
  error: { color: colors.destructive.text, marginBottom: SPACING.md },
  success: { color: colors.successText, marginBottom: SPACING.md },
});
