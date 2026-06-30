/**
 * ``SupportCareScreen`` — the always-available Support & care surface (issue
 * #892), reachable any time from the Settings hub. It mirrors the resources of
 * the reactive ``CareSupportNote`` but as a calm, standing invitation rather
 * than a response to a distress signal: a header-role message, the four shared
 * ``CareResourceCard``s, and a quiet care-boundary caption. Deliberately NOT a
 * chatbot — no avatar, no sender, no reply, no Send. Tokens only.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CARE_LIMITS_LINE, STANDING_CARE } from './careResources';

import CareResourceCard from '@/components/care/CareResourceCard';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { SPACING, editorialType, ink } from '@/design/tokens';

const SupportCareScreen = (): React.JSX.Element => (
  <ScreenScaffold scroll testID="support-care-screen">
    <ScreenHeader
      eyebrow="You are not alone"
      title="Support & care"
      lead="Support you can reach any time — not just when things are hard."
    />
    <Text style={styles.message} accessibilityRole="header">
      {STANDING_CARE.message}
    </Text>
    <View style={styles.resources}>
      {STANDING_CARE.resources.map((resource) => (
        <CareResourceCard key={resource.kind} resource={resource} />
      ))}
    </View>
    <Text style={styles.limits}>{CARE_LIMITS_LINE}</Text>
  </ScreenScaffold>
);

const styles = StyleSheet.create({
  message: {
    ...editorialType.title,
    color: ink.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.md,
  },
  resources: {
    marginBottom: SPACING.lg,
  },
  limits: {
    ...editorialType.caption,
    color: ink.soft,
  },
});

export default SupportCareScreen;
