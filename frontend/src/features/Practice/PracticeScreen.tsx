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
 *   - `PracticeSwitcherSheet` (ritual-10) handles practice replacement.
 *
 * The screen itself stays under ~250 LoC by keeping all state inside the
 * extracted hooks and the inner session component.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import PracticeSelector from './PracticeSelector';
import WeeklyProgress from './WeeklyProgress';

import type { PracticeSessionResponse, UserPractice } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors, touchTarget } from '@/design/tokens';
import { stageService } from '@/features/Map/services/stageService';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import { FrequencyBanner } from '@/features/Practice/components/FrequencyBanner';
import { PracticeSwitcherSheet } from '@/features/Practice/components/PracticeSwitcherSheet';
import { useActivePractice } from '@/features/Practice/hooks/useActivePractice';
import { useWeeklyProgress } from '@/features/Practice/hooks/useWeeklyProgress';
import { useAppNavigation, useAppRoute } from '@/navigation/hooks';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useDerivedCurrentStage } from '@/store/useProgramProgression';
import { selectCurrentStage, useStageStore } from '@/store/useStageStore';

type ActivePracticeHook = ReturnType<typeof useActivePractice>;
type WeeklyProgressHook = ReturnType<typeof useWeeklyProgress>;

/**
 * Owns the switcher-visibility state and returns the banner + switcher as
 * memoized elements (stable references unless their inputs change), so passing
 * ``banner`` as a FlatList ``ListHeaderComponent`` doesn't re-diff every render.
 */
function usePracticeChrome(
  stageNumber: number,
  currentPracticeId: number | null,
  onReplaced: (_next: UserPractice) => void,
): { banner: React.JSX.Element; switcher: React.JSX.Element } {
  const [showSwitcher, setShowSwitcher] = useState(false);
  const open = useCallback(() => setShowSwitcher(true), []);
  const close = useCallback(() => setShowSwitcher(false), []);
  const banner = useMemo(
    () => <FrequencyBanner stageNumber={stageNumber} onSwitch={open} />,
    [stageNumber, open],
  );
  const switcher = useMemo(
    () => (
      <PracticeSwitcherSheet
        visible={showSwitcher}
        stageNumber={stageNumber}
        currentPracticeId={currentPracticeId}
        onClose={close}
        onReplaced={onReplaced}
      />
    ),
    [showSwitcher, stageNumber, currentPracticeId, close, onReplaced],
  );
  return { banner, switcher };
}

const PracticeScreen = (): React.JSX.Element => {
  const stageNumber = useResolvedStageNumber();
  const { userTimezone } = useAuth();
  const active = useActivePractice(stageNumber);
  const weekly = useWeeklyProgress();
  const handleSwitcherReplaced = useSwitcherReplaced(active.updateActivePractice, weekly.refresh);
  const handleWriteReflection = useWriteReflection(active.effectiveName, active.practice);
  const currentPracticeId = active.activeUserPractice?.practice_id ?? null;
  const { banner, switcher } = usePracticeChrome(
    stageNumber,
    currentPracticeId,
    handleSwitcherReplaced,
  );

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
        switcher={switcher}
        stageNumber={stageNumber}
      />
    );
  }

  return (
    <SelectionView
      active={active}
      weekly={weekly}
      currentPracticeId={currentPracticeId}
      banner={banner}
      switcher={switcher}
      stageNumber={stageNumber}
    />
  );
};

/**
 * Discoverable entry point to the (now pushed) practice catalog, seeded with the
 * user's resolved stage. Rendered on the Practice screen in both the active and
 * selection states so the catalog stays reachable after it left the bottom nav
 * (practice-redesign-01).
 */
const BrowseAllPracticesButton = ({ stageNumber }: { stageNumber: number }): React.JSX.Element => {
  // Catalog is a pushed RootStack screen (not a tab), so navigate with the
  // stack-typed navigation rather than the tab-scoped useAppNavigation.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <TouchableOpacity
      style={styles.browseCatalog}
      onPress={() => navigation.navigate('Catalog', { stageNumber })}
      accessibilityRole="button"
      accessibilityLabel="Browse all practices"
      testID="browse-catalog-button"
    >
      <Text style={styles.browseCatalogText}>Browse all practices</Text>
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
  switcher: React.JSX.Element;
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
  switcher,
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
        {/* Above the session by design: the catalog must be reachable from the
            active state too (practice-redesign-01). It sits in the scroll header,
            not over the timer, so it doesn't intercept mid-session taps. */}
        <BrowseAllPracticesButton stageNumber={stageNumber} />
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
        {switcher}
      </ScrollView>
    </View>
  );
};

interface SelectionViewProps {
  active: ActivePracticeHook;
  weekly: WeeklyProgressHook;
  currentPracticeId: number | null;
  banner: React.JSX.Element;
  switcher: React.JSX.Element;
  stageNumber: number;
}

// The selection branch lets the windowed PracticeSelector own the scroll: a
// vertical FlatList nested in a vertical ScrollView stops virtualizing.
const SelectionView = ({
  active,
  weekly,
  currentPracticeId,
  banner,
  switcher,
  stageNumber,
}: SelectionViewProps): React.JSX.Element => {
  // ``selectPractice`` is already stable (useCallback in the hook); wrap it once
  // so PracticeCard's React.memo isn't defeated by a fresh arrow each render.
  const { selectPractice } = active;
  const insets = useSafeAreaInsets();
  const handleSelect = useCallback((id: number) => void selectPractice(id), [selectPractice]);
  // Memoized so SectionList doesn't re-reconcile its header on unrelated renders.
  const listHeader = useMemo(
    () => (
      <>
        {banner}
        <BrowseAllPracticesButton stageNumber={stageNumber} />
      </>
    ),
    [banner, stageNumber],
  );
  return (
    <View
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="practice-screen"
    >
      <View style={styles.fill} testID="selection-view">
        <PracticeSelector
          practices={active.availablePractices}
          selectedPracticeId={currentPracticeId}
          onSelect={handleSelect}
          isLoading={false}
          ListHeaderComponent={listHeader}
          ListFooterComponent={<WeeklyProgress count={weekly.count} />}
        />
      </View>
      {switcher}
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

function useSwitcherReplaced(
  updateActivePractice: ActivePracticeHook['updateActivePractice'],
  refreshWeekly: WeeklyProgressHook['refresh'],
): (_next: UserPractice) => void {
  // Take stable function references (not the whole hook bag); the parent
  // hook objects are new on every render, so depending on them would
  // re-create the callback each pass.
  return useCallback(
    (next: UserPractice) => {
      updateActivePractice(next);
      void refreshWeekly();
    },
    [updateActivePractice, refreshWeekly],
  );
}

function useWriteReflection(
  effectiveName: string | null,
  practice: ActivePracticeHook['practice'],
): (_args: { session: PracticeSessionResponse; insight: string | null }) => void {
  const navigation = useAppNavigation();
  // The captured ``insight`` is persisted on the server-side
  // ``practice_session.insight`` column (ritual-04). A follow-up will
  // extend `RootTabParamList.Journal` with an ``initialDraft`` field so
  // BotMason can open with the user's just-typed sentence; until then the
  // journal opens blank and the insight is queryable alongside the session.
  return useCallback(
    ({ session }) => {
      const name = effectiveName ?? practice?.name ?? 'Practice';
      navigation.navigate('Journal', {
        tag: 'practice_note',
        practiceSessionId: session.id,
        userPracticeId: session.user_practice_id,
        practiceName: name,
        practiceDuration: Math.round(session.duration_minutes),
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
