import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ink, rhythm, type as typeRamp } from '@/design/tokens';

interface EditorialSectionProps {
  /** Optional serif section title. */
  title?: string;
  children: React.ReactNode;
  testID?: string;
}

/**
 * A titled editorial band (#825): a serif `type().heading` title over its
 * children, separated from the previous section by `rhythm.sectionGap`.
 * Token-only and AA on `surface.canvas`.
 */
export const EditorialSection = ({
  title,
  children,
  testID,
}: EditorialSectionProps): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.section} testID={testID}>
      {title ? (
        <Text style={[t.heading, styles.title]} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    marginTop: rhythm.sectionGap,
  },
  title: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
});

export default EditorialSection;
