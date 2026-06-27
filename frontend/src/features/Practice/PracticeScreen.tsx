/**
 * `PracticeScreen` — ritual-11 composition shell.
 *
 * Replaces the pre-ritual-11 729-LoC monolith with a layered surface that
 * delegates to the new pieces:
 *
 *   - `useActivePractice` resolves the user's active practice + effective
 *     config from the stage catalogue and any per-user overrides.
 *   - `useWeeklyProgress` reads the ritual-04 insights endpoint (with a
 *     fallback to the legacy `week-count` route) for the bar at the foot.
 *   - `FrequencyBanner` (ritual-10) renders the server-formatted banner.
 *   - `ActiveRitualSession` owns the engine, mode dispatch, configurator
 *     sheet, and the ritual-12 insight capture modal when a practice is
 *     active.
 *
 * When no practice is set for the stage the screen shows a minimal empty state
 * whose only action opens the catalog (the single place to choose/switch).
 *
 * The screen itself stays small by keeping all state inside the extracted hooks
 * and the inner session component.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import WeeklyProgress from './WeeklyProgress';

import type { PracticeSessionResponse } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors, touchTarget } from '@/design/tokens';
import { stageService } from '@/features/Map/services/stageService';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import { FrequencyBanner } from '@/features/Practice/components/FrequencyBanner';
import { useActivePractice } from '@/features/Practice/hooks/useActivePractice';
import { useWeeklyProgress } from '@/features/Practice/hooks/useWeeklyProgress';
import { useAppRoute } from '@/navigation/hooks';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useDerivedCurrentStage } from '@/store/useProgramProgression';
import { selectCurrentStage, useStageStore } from '@/store/useStageStore';

type ActivePracticeHook = ReturnType<typeof useActivePractice>;
type WeeklyProgressHook = ReturnType<typeof useWeeklyProgress>;

/**
 * Returns the frequency chip as a memoized element (stable reference unless the
 * stage changes). The chip is display-only — switching practices is the
 * explicit "Change practice" button, which routes through the catalog.
 */
function usePracticeChrome(stageNumber: number): { banner: React.JSX.Element } {
  const banner = useMemo(() => <FrequencyBanner stageNumber={stageNumber} />, [stageNumber]);
  return { banner };
}

const PracticeScreen = (): React.JSX.Element => {
  const stageNumber = useResolvedStageNumber();
  const { userTimezone } = useAuth();
  const active = useActivePractice(stageNumber);
  const weekly = useWeeklyProgress();
  const handleWriteReflection = useWriteReflection(active.effectiveName, active.practice);
  const { banner } = usePracticeChrome(stageNumber);

  if (active.isLoading) return <LoadingView />;
  if (active.error && !active.activeUserPractice) {
    return <ErrorView error={active.error} onRetry={active.refresh} />;
  }
  if (active.activeUserPractice && active.practice && active.effectiveConfig) {
    return (
      <ActiveSessionView
        userPractice={active.activeUserPractice}
        practiceName={active.practice.name}
        effectiveName={active.effectiveName}
        effectiveConfig={active.effectiveConfig}
        userTimezone={userTimezone}
        weekly={weekly}
        onUserPracticeUpdated={active.updateActivePractice}
        onWriteReflection={handleWriteReflection}
        banner={banner}
        stageNumber={stageNumber}
      />
    );
  }

  return <EmptyStateView stageNumber={stageNumber} />;
};

interface CatalogButtonProps {
  stageNumber: number;
  label: string;
  testID: string;
}

/**
 * Button-shaped entry point to the (pushed) practice catalog, seeded with the
 * user's resolved stage. Used as "Change practice" in the active state and
 * "Browse all practices" in the selection state — both open the same catalog.
 */
const CatalogButton = ({ stageNumber, label, testID }: CatalogButtonProps): React.JSX.Element => {
  // Catalog is a pushed RootStack screen (not a tab), so navigate with the
  // stack-typed navigation rather than the tab-scoped useAppNavigation.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <TouchableOpacity
      style={styles.browseCatalog}
      onPress={() => navigation.navigate('Catalog', { stageNumber })}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={styles.browseCatalogText}>{label}</Text>
    </TouchableOpacity>
  );
};

interface ActiveSessionViewProps {
  userPractice: NonNullable<ActivePracticeHook['activeUserPractice']>;
  practiceName: string;
  effectiveName: string | null;
  effectiveConfig: NonNullable<ActivePracticeHook['effectiveConfig']>;
  userTimezone: string;
  weekly: WeeklyProgressHook;
  onUserPracticeUpdated: ActivePracticeHook['updateActivePractice'];
  onWriteReflection: (_args: { session: PracticeSessionResponse; insight: string | null }) => void;
  banner: React.JSX.Element;
  stageNumber: number;
}

const ActiveSessionView = ({
  userPractice,
  practiceName,
  effectiveName,
  effectiveConfig,
  userTimezone,
  weekly,
  onUserPracticeUpdated,
  onWriteReflection,
  banner,
  stageNumber,
}: ActiveSessionViewProps): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  return (
    // paddingTop lives on the wrapper so the ScrollView's *viewport* starts
    // below the notch (content can't scroll up behind it); paddingBottom rides
    // contentContainerStyle so the scroll content clears the home indicator.
    <View style={[styles.screen, { paddingTop: insets.top }]} testID="practice-screen-safe-area">
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom }]}
        testID="practice-screen"
      >
        {banner}
        {/* The primary switch affordance, in the scroll header (not over the
            timer, so it doesn't intercept mid-session taps). */}
        <CatalogButton
          stageNumber={stageNumber}
          label="Change practice"
          testID="change-practice-button"
        />
        <ActiveRitualSession
          key={`practice-${userPractice.id}`}
          userPractice={userPractice}
          effectiveName={effectiveName ?? practiceName}
          effectiveConfig={effectiveConfig}
          userTimezone={userTimezone}
          onSessionApply={weekly.increment}
          onSessionRollback={weekly.decrement}
          onSessionCommitted={() => void weekly.refresh()}
          onUserPracticeUpdated={onUserPracticeUpdated}
          onWriteReflection={onWriteReflection}
        />
        <WeeklyProgress count={weekly.count} />
      </ScrollView>
    </View>
  );
};

interface EmptyStateViewProps {
  stageNumber: number;
}

// Calm empty state when no practice is set for the stage: the catalog is the
// single place to choose one, so this is just a prompt + one CTA into it.
const EmptyStateView = ({ stageNumber }: EmptyStateViewProps): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.empty, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="practice-empty-state"
    >
      <Text style={styles.emptyText}>No practice set for this stage yet.</Text>
      <CatalogButton
        stageNumber={stageNumber}
        label="Browse practices"
        testID="browse-catalog-button"
      />
    </View>
  );
};

function useResolvedStageNumber(): number {
  const route = useAppRoute<'Practice'>();
  const storeCurrentStage = useStageStore(selectCurrentStage);
  const storeStages = useStageStore((s) => s.stages);
  // Master-date wiring (#323): when the user has set a program start date,
  // derive the active stage from ``today - programStartDate`` so the
  // screen tracks real elapsed time rather than the server's count-based
  // current stage. Falls back to the store value when no anchor is set.
  const derivedCurrentStage = useDerivedCurrentStage(storeCurrentStage);
  useEffect(() => {
    if (storeStages.length === 0) void stageService.loadStages();
  }, [storeStages.length]);
  return route.params?.stageNumber ?? derivedCurrentStage;
}

function useWriteReflection(
  effectiveName: string | null,
  practice: ActivePracticeHook['practice'],
): (_args: { session: PracticeSessionResponse; insight: string | null }) => void {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Opens the long-form entry screen pre-linked to this session; the captured
  // insight still lives on the server-side ``practice_session.insight`` column
  // (ritual-04), queryable alongside the session.
  return useCallback(
    ({ session }) => {
      const name = effectiveName ?? practice?.name ?? 'Practice';
      navigation.navigate('JournalEntry', {
        practiceSessionId: session.id,
        userPracticeId: session.user_practice_id,
        prefillTitle: `After ${name}`,
      });
    },
    [effectiveName, practice, navigation],
  );
}

const LoadingView = (): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.centered, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="practice-loading"
    >
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
};

const ErrorView = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void> | void;
}): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.centered, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="practice-error"
    >
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity
        style={styles.retryButton}
        onPress={() => void onRetry()}
        testID="retry-button"
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.primary },
  fill: { flex: 1 },
  scrollContent: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
    backgroundColor: colors.background.primary,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: SPACING.lg,
    padding: SPACING.xxl,
    backgroundColor: colors.background.primary,
  },
  emptyText: {
    fontSize: 16,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  errorText: {
    color: colors.danger,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  retryButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xl,
  },
  retryButtonText: { color: colors.text.light, fontWeight: '600' },
  browseCatalog: {
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
  },
  // fontSize 16 mirrors retryButtonText above (the app has no static type token;
  // typography() is viewport-responsive) so the two buttons stay visually aligned.
  browseCatalogText: { color: colors.primary, fontWeight: '600', fontSize: 16 },
});

export default PracticeScreen;
