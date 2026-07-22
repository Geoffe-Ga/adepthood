/**
 * `PracticeScreen` — the full-bleed dark "player" (#1905, epic #1904).
 *
 * The whole screen is a single deep-umber card (`showcase.canvas`) with a
 * fixed, non-scrolling layout: the session centered in the middle and the
 * weekly-progress footer pinned at the foot. Everything that is not the
 * ritual itself — the old showcase hero, the frequency banner, the inline
 * "Change practice" button — is gone; the header drawer keeps the
 * catalog/customize/details/create paths until the epic's Practice/Catalog
 * tab switcher lands.
 *
 * Composition stays layered:
 *   - `useActivePractice` resolves the user's active practice + effective
 *     config from the stage catalogue and any per-user overrides.
 *   - `useWeeklyProgress` reads the ritual-04 insights endpoint (with a
 *     fallback to the legacy `week-count` route) for the footer.
 *   - `ActiveRitualSession` owns the engine, mode dispatch, configurator
 *     sheet, and the ritual-12 insight capture modal when a practice is
 *     active.
 *   - `PracticeIdentityHeader` pins the player identity (title, tappable
 *     stage chip, effective ritual name, customize pencil) to the top region
 *     and collapses to the title alone while a session runs.
 *
 * When no practice is set for the stage the screen shows a minimal dark
 * empty state whose only action opens the catalog.
 */
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import WeeklyProgress from './WeeklyProgress';

import type { PracticeSessionResponse } from '@/api';
import {
  DrawerNavSection,
  ScreenDrawer,
  useScreenDrawer,
  type ScreenDrawerState,
} from '@/components/drawer';
import { ContentContainer } from '@/components/layout/ContentContainer';
import { useAuth } from '@/context/AuthContext';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  accentDark,
  editorialType,
  onShowcase,
  showcase,
  touchTarget,
} from '@/design/tokens';
import { stageService } from '@/features/Map/services/stageService';
import ActiveRitualSession, {
  type ActiveRitualSessionHandle,
} from '@/features/Practice/components/ActiveRitualSession';
import PracticeDrawer from '@/features/Practice/components/PracticeDrawer';
import PracticeIdentityHeader from '@/features/Practice/components/PracticeIdentityHeader';
import type { RitualState } from '@/features/Practice/engine/types';
import { useActivePractice } from '@/features/Practice/hooks/useActivePractice';
import { useWeeklyProgress } from '@/features/Practice/hooks/useWeeklyProgress';
import { useAppRoute } from '@/navigation/hooks';
import type { RootStackParamList } from '@/navigation/RootStack';
import { useDerivedCurrentStage } from '@/store/useProgramProgression';
import { selectCurrentStage, useStageStore } from '@/store/useStageStore';

type ActivePracticeHook = ReturnType<typeof useActivePractice>;
type WeeklyProgressHook = ReturnType<typeof useWeeklyProgress>;

/** The glyph fronting the dark empty state. */
const EMPTY_GLYPH = '🧘';

/**
 * Re-fetch the active practice whenever the screen regains focus. The
 * Practice tab stays mounted while the user pushes to the catalog / detail
 * screen to choose a practice; without this, returning would show the stale
 * selection (the selection saved fine — it just wasn't re-read). The first
 * focus is skipped because the hooks already fetch on mount, and the refresh
 * is silent so the current practice stays on screen while it reloads.
 */
function useFocusRefresh(refresh: (_opts?: { silent?: boolean }) => Promise<void>): void {
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refresh({ silent: true });
    }, [refresh]),
  );
}

const PracticeScreen = (): React.JSX.Element => {
  const resolvedStage = useResolvedStageNumber();
  // A stage picked from the identity header's chip overrides the derived
  // stage locally; route params and the stage store stay untouched so other
  // screens keep their own resolution.
  const [stageOverride, setStageOverride] = useState<number | null>(null);
  const stageNumber = stageOverride ?? resolvedStage;
  const { userTimezone } = useAuth();
  const active = useActivePractice(stageNumber);
  const weekly = useWeeklyProgress();
  const handleWriteReflection = useWriteReflection(active.effectiveName, active.practice);
  useFocusRefresh(active.refresh);
  const drawer = useScreenDrawer('Practice');
  const sessionRef = useRef<ActiveRitualSessionHandle>(null);
  const openConfigurator = useCallback(() => {
    sessionRef.current?.openConfigurator();
  }, []);

  const hasActivePractice = Boolean(
    active.activeUserPractice && active.practice && active.effectiveConfig,
  );

  return (
    <>
      <PracticeBody
        active={active}
        userTimezone={userTimezone}
        weekly={weekly}
        onWriteReflection={handleWriteReflection}
        stageNumber={stageNumber}
        sessionRef={sessionRef}
        onStageChange={setStageOverride}
        onCustomize={openConfigurator}
      />
      <PracticeScreenDrawer
        drawer={drawer}
        hasActivePractice={hasActivePractice}
        stageNumber={stageNumber}
        practiceId={active.practice?.id}
        onCustomize={openConfigurator}
      />
    </>
  );
};

interface PracticeBodyProps {
  active: ActivePracticeHook;
  userTimezone: string;
  weekly: WeeklyProgressHook;
  onWriteReflection: (_args: { session: PracticeSessionResponse; insight: string | null }) => void;
  stageNumber: number;
  sessionRef: React.Ref<ActiveRitualSessionHandle>;
  onStageChange: (_stage: number) => void;
  onCustomize: () => void;
}

// Selects the screen body for the current load state: a loading/error
// placeholder, the active player, or the empty state when no practice is set.
// Every state shares the same full-bleed umber ground.
const PracticeBody = ({
  active,
  userTimezone,
  weekly,
  onWriteReflection,
  stageNumber,
  sessionRef,
  onStageChange,
  onCustomize,
}: PracticeBodyProps): React.JSX.Element => {
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
        onWriteReflection={onWriteReflection}
        stageNumber={stageNumber}
        sessionRef={sessionRef}
        onStageChange={onStageChange}
        onCustomize={onCustomize}
      />
    );
  }
  return <EmptyStateView stageNumber={stageNumber} />;
};

interface PracticeScreenDrawerProps {
  drawer: ScreenDrawerState;
  hasActivePractice: boolean;
  stageNumber: number;
  practiceId?: number;
  onCustomize: () => void;
}

// The header drawer: catalog/customize/details/create actions in the active
// state, browse/create when empty. Kept as its own component so the screen's
// render stays small and the drawer wiring lives in one place.
const PracticeScreenDrawer = ({
  drawer,
  hasActivePractice,
  stageNumber,
  practiceId,
  onCustomize,
}: PracticeScreenDrawerProps): React.JSX.Element => (
  <ScreenDrawer
    visible={drawer.isOpen}
    onClose={drawer.close}
    screenName="Practice"
    title="Practice"
  >
    <DrawerNavSection currentScreen="Practice" onNavigate={drawer.close} />
    <PracticeDrawer
      hasActivePractice={hasActivePractice}
      stageNumber={stageNumber}
      practiceId={practiceId}
      onCustomize={onCustomize}
      onClose={drawer.close}
    />
  </ScreenDrawer>
);

/**
 * Button-shaped entry point to the (pushed) practice catalog, seeded with the
 * user's resolved stage — the empty state's single CTA, styled for the dark
 * player ground.
 */
const CatalogButton = ({
  stageNumber,
  label,
  testID,
}: {
  stageNumber: number;
  label: string;
  testID: string;
}): React.JSX.Element => {
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
  stageNumber: number;
  sessionRef?: React.Ref<ActiveRitualSessionHandle>;
  onStageChange: (_stage: number) => void;
  onCustomize: () => void;
}

// The fixed player layout: no outer scroll. The identity header sits in the
// top region, the session floats centered in the flexible middle, and the
// weekly footer is pinned at the foot inside the safe area.
const ActiveSessionView = (props: ActiveSessionViewProps): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  // Mirror the engine's status so the identity header can collapse while a
  // session holds the screen (running or paused); idle and complete both
  // show the full identity block.
  const [status, setStatus] = useState<RitualState['status']>('idle');
  return (
    <View
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="practice-screen-safe-area"
    >
      <ContentContainer fill>
        <View style={styles.playerBody} testID="practice-screen">
          <PracticeIdentityHeader
            stageNumber={props.stageNumber}
            practiceName={props.practiceName}
            ritualName={props.effectiveName ?? props.practiceName}
            collapsed={status === 'running' || status === 'paused'}
            onCustomize={props.onCustomize}
            onStageChange={props.onStageChange}
          />
          <View style={styles.sessionRegion}>
            <ActiveRitualSession
              key={`practice-${props.userPractice.id}`}
              ref={props.sessionRef}
              userPractice={props.userPractice}
              effectiveName={props.effectiveName ?? props.practiceName}
              effectiveConfig={props.effectiveConfig}
              userTimezone={props.userTimezone}
              onSessionApply={props.weekly.increment}
              onSessionRollback={props.weekly.decrement}
              onSessionCommitted={() => void props.weekly.refresh()}
              onUserPracticeUpdated={props.onUserPracticeUpdated}
              onWriteReflection={props.onWriteReflection}
              onStatusChange={setStatus}
            />
          </View>
          <WeeklyProgress count={props.weekly.count} />
        </View>
      </ContentContainer>
    </View>
  );
};

interface EmptyStateViewProps {
  stageNumber: number;
}

// Calm dark empty state when no practice is set for the stage: the catalog is
// the single place to choose one, so this is just a prompt + one CTA into it.
// Rendered by hand (not the shared EmptyState) because that component paints
// its own opaque light surface, which would break the full-bleed dark player.
const EmptyStateView = ({ stageNumber }: EmptyStateViewProps): React.JSX.Element => {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <ContentContainer fill>
        <View
          style={[styles.emptyState, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
          testID="practice-empty-state"
        >
          <Text
            style={styles.emptyGlyph}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {EMPTY_GLYPH}
          </Text>
          <Text style={styles.emptyTitle} accessibilityRole="header">
            No practice yet
          </Text>
          <Text style={styles.emptyBody}>No practice set for this stage yet.</Text>
          <CatalogButton
            stageNumber={stageNumber}
            label="Browse practices"
            testID="browse-catalog-button"
          />
        </View>
      </ContentContainer>
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
      <ActivityIndicator size="large" color={accentDark.primary} />
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
  screen: { flex: 1, backgroundColor: showcase.canvas },
  playerBody: { flex: 1, padding: SPACING.md },
  // The flexible middle: the session settles centered between the identity
  // header's top region and the weekly footer.
  sessionRegion: { flex: 1, justifyContent: 'center' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
    backgroundColor: showcase.canvas,
  },
  errorText: {
    color: onShowcase.primary,
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
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
  },
  emptyGlyph: { fontSize: 48, marginBottom: SPACING.lg },
  emptyTitle: { ...editorialType.display, color: onShowcase.primary, marginBottom: SPACING.sm },
  emptyBody: {
    ...editorialType.note,
    color: onShowcase.soft,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  browseCatalog: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: accentDark.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
  },
  // fontSize 16 mirrors retryButtonText above (the app has no static type token;
  // typography() is viewport-responsive) so the two buttons stay visually aligned.
  browseCatalogText: { color: accentDark.primary, fontWeight: '600', fontSize: 16 },
});

export default PracticeScreen;
