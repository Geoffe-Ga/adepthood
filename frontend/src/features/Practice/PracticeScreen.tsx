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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RefreshCw } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { EmptyState } from '@/components/feedback/EmptyState';
import { ShowcaseCard } from '@/components/layout/ShowcaseCard';
import { useAuth } from '@/context/AuthContext';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  onShowcase,
  surface,
  touchTarget,
} from '@/design/tokens';
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
function usePracticeChrome(
  stageNumber: number,
  refreshSignal: number,
): { banner: React.JSX.Element } {
  const banner = useMemo(
    () => <FrequencyBanner stageNumber={stageNumber} refreshSignal={refreshSignal} />,
    [stageNumber, refreshSignal],
  );
  return { banner };
}

/**
 * Re-fetch the active practice + frequency banner whenever the screen regains
 * focus. The Practice tab stays mounted while the user pushes to the catalog /
 * detail screen to choose a practice; without this, returning would show the
 * stale selection (the selection saved fine — it just wasn't re-read). The
 * first focus is skipped because the hooks already fetch on mount, and the
 * refresh is silent so the current practice stays on screen while it reloads.
 */
function useFocusRefresh(refresh: (_opts?: { silent?: boolean }) => Promise<void>): number {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refresh({ silent: true });
      setRefreshSignal((n) => n + 1);
    }, [refresh]),
  );
  return refreshSignal;
}

const PracticeScreen = (): React.JSX.Element => {
  const stageNumber = useResolvedStageNumber();
  const { userTimezone } = useAuth();
  const active = useActivePractice(stageNumber);
  const weekly = useWeeklyProgress();
  const handleWriteReflection = useWriteReflection(active.effectiveName, active.practice);
  const refreshSignal = useFocusRefresh(active.refresh);
  const { banner } = usePracticeChrome(stageNumber, refreshSignal);

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
  /** Optional leading icon (e.g. the RefreshCw glyph on "Change practice"). */
  icon?: React.ReactNode;
}

/**
 * Button-shaped entry point to the (pushed) practice catalog, seeded with the
 * user's resolved stage. Used as "Change practice" in the active state and
 * "Browse all practices" in the selection state — both open the same catalog.
 */
const CatalogButton = ({
  stageNumber,
  label,
  testID,
  icon,
}: CatalogButtonProps): React.JSX.Element => {
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
      {icon}
      <Text style={styles.browseCatalogText}>{label}</Text>
    </TouchableOpacity>
  );
};

/**
 * The arrival hero for the active practice — a focal warm-umber showcase band
 * that frames the session as a "begin a session" moment. Presentation only:
 * the large Begin control lives in the engine's mode view below (its
 * `idle → running` wiring is unchanged).
 */
const BeginHero = ({ practiceName }: { practiceName: string }): React.JSX.Element => (
  <ShowcaseCard style={styles.hero} testID="practice-begin-hero">
    <Text style={styles.heroEyebrow}>PRACTICE</Text>
    <Text style={styles.heroTitle} accessibilityRole="header">
      Begin a session
    </Text>
    <Text style={styles.heroLead}>Settle in with {practiceName} when you’re ready.</Text>
  </ShowcaseCard>
);

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
        <BeginHero practiceName={effectiveName ?? practiceName} />
        {/* The primary switch affordance, in the scroll header (not over the
            timer, so it doesn't intercept mid-session taps). */}
        <CatalogButton
          stageNumber={stageNumber}
          label="Change practice"
          testID="change-practice-button"
          icon={<RefreshCw size={16} color={accent.primary} style={styles.browseCatalogIcon} />}
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
    <EmptyState
      glyph="🧘"
      title="No practice yet"
      body="No practice set for this stage yet."
      cta={
        <CatalogButton
          stageNumber={stageNumber}
          label="Browse practices"
          testID="browse-catalog-button"
        />
      }
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="practice-empty-state"
    />
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
      <ActivityIndicator size="large" color={accent.primary} />
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
  screen: { flex: 1, backgroundColor: surface.canvas },
  fill: { flex: 1 },
  scrollContent: { padding: SPACING.md, paddingBottom: SPACING.xxl },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
    backgroundColor: surface.canvas,
  },
  errorText: {
    color: colors.danger,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  retryButton: {
    backgroundColor: accent.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xl,
  },
  retryButtonText: { color: accent.onPrimary, fontWeight: '600' },
  hero: { marginHorizontal: SPACING.md, marginBottom: SPACING.md },
  heroEyebrow: {
    ...editorialType.caption,
    color: onShowcase.muted,
    letterSpacing: 1.5,
    marginBottom: SPACING.xs,
  },
  heroTitle: { ...editorialType.display, color: onShowcase.primary, marginBottom: SPACING.xs },
  heroLead: { ...editorialType.note, color: onShowcase.soft },
  browseCatalog: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
  },
  browseCatalogIcon: { marginRight: SPACING.xs },
  // fontSize 16 mirrors retryButtonText above (the app has no static type token;
  // typography() is viewport-responsive) so the two buttons stay visually aligned.
  browseCatalogText: { color: accent.primary, fontWeight: '600', fontSize: 16 },
});

export default PracticeScreen;
