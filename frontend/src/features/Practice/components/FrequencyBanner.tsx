/**
 * `FrequencyBanner` — display-only banner that sits above the active
 * Practice. Shows the user's current spiral-dynamics colour, aspect of
 * wholeness, and the server-formatted banner copy (verbatim — the client
 * never assembles the string itself; that's the whole point of
 * ritual-05's `GET /user-practices/current/frequency`).
 *
 * Tap target opens the practice switcher (parent owns the sheet's
 * visibility).
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { FrequencyResponse } from '@/api';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { swatchFor, type ColorSwatch } from '@/features/Practice/data/colorPalette';
import { useFrequency } from '@/features/Practice/hooks/useFrequency';

export interface FrequencyBannerProps {
  /**
   * Pre-fetched payload. When provided, takes precedence over the hook —
   * the same dependency-injection pattern the mode views use for
   * storybook and testing.
   */
  data?: FrequencyResponse;
  /** Called when the banner body is tapped — open the switcher sheet. */
  onSwitch: () => void;
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

interface BannerContentProps {
  data: FrequencyResponse;
  swatch: ColorSwatch;
  onSwitch: () => void;
}

function BannerContent({ data, swatch, onSwitch }: BannerContentProps) {
  const textStyle = { color: swatch.text };
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={data.banner_text}
      accessibilityHint="Tap to switch your current practice"
      activeOpacity={0.85}
      onPress={onSwitch}
      style={[styles.content, { backgroundColor: swatch.bg }]}
      testID="frequency-banner-content"
    >
      <View style={styles.headerRow}>
        <View style={[styles.aspectChip, { borderColor: swatch.text }]}>
          <Text style={[styles.aspectChipText, textStyle]} testID="frequency-banner-aspect">
            {data.aspect}
          </Text>
        </View>
        <Text style={[styles.colorLabel, textStyle]} testID="frequency-banner-color">
          {data.color}
        </Text>
      </View>
      <Text style={[styles.bannerText, textStyle]} testID="frequency-banner-text">
        {data.banner_text}
      </Text>
      <Text style={[styles.switchHint, textStyle]}>Tap to replace this practice</Text>
    </TouchableOpacity>
  );
}

export function FrequencyBanner({ data: injected, onSwitch }: FrequencyBannerProps) {
  const hook = useFrequency();
  // Injected data wins for storybook / tests; otherwise consume the hook.
  const data = injected ?? hook.data;
  const isLoading = injected ? false : hook.isLoading;
  const error = injected ? null : hook.error;

  if (isLoading && !data) return <BannerSkeleton />;
  if (error && !data) return <BannerError onRetry={hook.refetch} />;
  if (!data) return null;
  return <BannerContent data={data} swatch={swatchFor(data.color)} onSwitch={onSwitch} />;
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
  content: {
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  aspectChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.circle,
    borderWidth: 1,
    marginRight: SPACING.sm,
  },
  aspectChipText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  colorLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bannerText: {
    fontSize: 15,
    lineHeight: 22,
  },
  switchHint: {
    marginTop: SPACING.sm,
    fontSize: 12,
    fontStyle: 'italic',
    opacity: 0.8,
  },
});
