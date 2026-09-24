import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ink, radius, rhythm, surface, type as typeRamp } from '@/design/tokens';

interface EvidenceSectionProps {
  title: string;
  testID: string;
  children: React.ReactNode;
}

/**
 * One source of evidence about a report, under its own announced heading.
 *
 * The detail pane keeps three of these apart -- what the reporter said, what the
 * app attached, what operators added -- because they have three different
 * authors and three different privacy stories, and an operator skimming a
 * report must never mistake one for another.
 */
export function EvidenceSection({
  title,
  testID,
  children,
}: EvidenceSectionProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.section} testID={testID}>
      <Text style={[t.heading, styles.title]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

interface EvidenceFieldProps {
  label: string;
  value: string;
  testID?: string;
}

/** One labelled value inside an evidence section. */
export function EvidenceField({ label, value, testID }: EvidenceFieldProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <Text style={[t.label, styles.label]}>{label}</Text>
      <Text style={[t.body, styles.value]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: rhythm.blockGap,
    marginBottom: rhythm.sectionGap,
  },
  title: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  field: {
    marginBottom: rhythm.blockGap,
  },
  label: {
    color: ink.soft,
  },
  value: {
    color: ink.primary,
  },
});
