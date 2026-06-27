/**
 * `FrequencyBanner` — display-only chip above the active Practice. Shows the
 * user's current spiral-dynamics colour (a swatch dot) and aspect of wholeness,
 * sourced from `GET /user-practices/current/frequency`. It is intentionally not
 * interactive — switching practices is a separate, explicit control.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { FrequencyResponse } from '@/api';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { swatchFor, type ColorSwatch } from '@/features/Practice/data/colorPalette';
import { useFrequency } from '@/features/Practice/hooks/useFrequency';

/** Diameter of the colour swatch dot in the chip. */
const SWATCH_DOT_SIZE = 14;

export interface FrequencyBannerProps {
  /**
   * Pre-fetched payload. When provided, takes precedence over the hook —
   * the same dependency-injection pattern the mode views use for
   * storybook and testing.
   */
  data?: FrequencyResponse;
  /**
   * Pin the chip to a specific stage. When omitted the server picks the stage
   * from the user's stored progress; passing the same stage the practice card
   * resolves keeps the chip and the card in lockstep on every render.
   */
  stageNumber?: number | null;
}

function BannerSkeleton() {
  return (
    <View style={styles.skeleton} testID="frequency-banner-skeleton">
      <ActivityIndicator color={colors.text.secondary} />
      <Text style={styles.skeletonLabel}>Loading your frequency…</Text>
    </View>
  );
}

function BannerError({ onRetry }: { onRetry: () => Promise<void> }) {
  return (
    <View style={styles.errorRow} testID="frequency-banner-error">
      <Text style={styles.errorText}>
        We couldn't load your frequency. Check your connection and try again.
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.retryButton}
        testID="frequency-banner-retry"
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

function FrequencyChip({ data, swatch }: { data: FrequencyResponse; swatch: ColorSwatch }) {
  return (
    <View
      style={styles.chip}
      accessibilityRole="text"
      accessibilityLabel={`${data.color} frequency · ${data.aspect}`}
      testID="frequency-banner-content"
    >
      <View
        style={[styles.swatchDot, { backgroundColor: swatch.bg }]}
        testID="frequency-chip-dot"
      />
      <Text style={styles.colorLabel} testID="frequency-banner-color">
        {data.color}
      </Text>
      <Text style={styles.aspectText} testID="frequency-banner-aspect">
        {data.aspect}
      </Text>
    </View>
  );
}

export function FrequencyBanner({ data: injected, stageNumber }: FrequencyBannerProps) {
  const hook = useFrequency(stageNumber);
  // Injected data wins for storybook / tests; otherwise consume the hook.
  const data = injected ?? hook.data;
  const isLoading = injected ? false : hook.isLoading;
  const error = injected ? null : hook.error;

  if (isLoading && !data) return <BannerSkeleton />;
  if (error && !data) return <BannerError onRetry={hook.refetch} />;
  if (!data) return null;
  return <FrequencyChip data={data} swatch={swatchFor(data.color)} />;
}

const styles = StyleSheet.create({
  skeleton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.lg,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  skeletonLabel: {
    marginLeft: SPACING.md,
    color: colors.text.secondary,
    fontSize: 14,
  },
  errorRow: {
    padding: SPACING.lg,
    backgroundColor: colors.destructive.background,
    borderColor: colors.destructive.border,
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.md,
  },
  errorText: {
    color: colors.destructive.text,
    fontSize: 14,
    marginBottom: SPACING.sm,
  },
  retryButton: {
    alignSelf: 'flex-start',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    backgroundColor: colors.destructive.text,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 14,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: colors.background.card,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  swatchDot: {
    width: SWATCH_DOT_SIZE,
    height: SWATCH_DOT_SIZE,
    borderRadius: BORDER_RADIUS.circle,
    marginRight: SPACING.sm,
  },
  colorLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: colors.text.primary,
    marginRight: SPACING.sm,
  },
  aspectText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text.secondary,
  },
});
