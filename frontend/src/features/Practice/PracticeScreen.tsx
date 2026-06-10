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
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import PracticeSelector from './PracticeSelector';
import WeeklyProgress from './WeeklyProgress';

import type { PracticeSessionResponse, UserPractice } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';
import { stageService } from '@/features/Map/services/stageService';
import ActiveRitualSession from '@/features/Practice/components/ActiveRitualSession';
import { FrequencyBanner } from '@/features/Practice/components/FrequencyBanner';
import { PracticeSwitcherSheet } from '@/features/Practice/components/PracticeSwitcherSheet';
import { useActivePractice } from '@/features/Practice/hooks/useActivePractice';
import { useWeeklyProgress } from '@/features/Practice/hooks/useWeeklyProgress';
import { useAppNavigation, useAppRoute } from '@/navigation/hooks';
import { useDerivedCurrentStage } from '@/store/useProgramProgression';
import { selectCurrentStage, useStageStore } from '@/store/useStageStore';

type ActivePracticeHook = ReturnType<typeof useActivePractice>;
type WeeklyProgressHook = ReturnType<typeof useWeeklyProgress>;

const PracticeScreen = (): React.JSX.Element => {
  const stageNumber = useResolvedStageNumber();
  const { userTimezone } = useAuth();
  const active = useActivePractice(stageNumber);
  const weekly = useWeeklyProgress();
  const [showSwitcher, setShowSwitcher] = useState(false);
  const handleSwitcherReplaced = useSwitcherReplaced(active.updateActivePractice, weekly.refresh);
  const handleWriteReflection = useWriteReflection(active.effectiveName, active.practice);

  if (active.isLoading) return <LoadingView />;
  if (active.error && !active.activeUserPractice) {
    return <ErrorView error={active.error} onRetry={active.refresh} />;
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      testID="practice-screen"
    >
      <FrequencyBanner stageNumber={stageNumber} onSwitch={() => setShowSwitcher(true)} />
      <PracticeBody
        active={active}
        weekly={weekly}
        userTimezone={userTimezone}
        onWriteReflection={handleWriteReflection}
      />
      <WeeklyProgress count={weekly.count} />
      <PracticeSwitcherSheet
        visible={showSwitcher}
        stageNumber={stageNumber}
        currentPracticeId={active.activeUserPractice?.practice_id ?? null}
        onClose={() => setShowSwitcher(false)}
        onReplaced={handleSwitcherReplaced}
      />
    </ScrollView>
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

interface PracticeBodyProps {
  active: ActivePracticeHook;
  weekly: WeeklyProgressHook;
  userTimezone: string;
  onWriteReflection: (_args: { session: PracticeSessionResponse; insight: string | null }) => void;
}

const PracticeBody = ({
  active,
  weekly,
  userTimezone,
  onWriteReflection,
}: PracticeBodyProps): React.JSX.Element => {
  if (active.activeUserPractice && active.practice && active.effectiveConfig) {
    return (
      <ActiveRitualSession
        key={`practice-${active.activeUserPractice.id}`}
        userPractice={active.activeUserPractice}
        effectiveName={active.effectiveName ?? active.practice.name}
        effectiveConfig={active.effectiveConfig}
        userTimezone={userTimezone}
        onSessionApply={weekly.increment}
        onSessionRollback={weekly.decrement}
        onSessionCommitted={() => void weekly.refresh()}
        onUserPracticeUpdated={active.updateActivePractice}
        onWriteReflection={onWriteReflection}
      />
    );
  }
  return (
    <View testID="selection-view">
      <PracticeSelector
        practices={active.availablePractices}
        selectedPracticeId={active.activeUserPractice?.practice_id ?? null}
        onSelect={(id) => void active.selectPractice(id)}
        isLoading={false}
      />
    </View>
  );
};

const LoadingView = (): React.JSX.Element => (
  <View style={styles.centered} testID="practice-loading">
    <ActivityIndicator size="large" color={colors.primary} />
  </View>
);

const ErrorView = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void> | void;
}): React.JSX.Element => (
  <View style={styles.centered} testID="practice-error">
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.primary },
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
});

export default PracticeScreen;
