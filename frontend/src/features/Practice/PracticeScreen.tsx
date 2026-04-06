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
import PracticeTimer from './PracticeTimer';
import WeeklyProgress from './WeeklyProgress';

import type {
  PracticeItem,
  PracticeSessionCreate,
  PracticeSessionResponse,
  UserPractice,
} from '@/api';
import { practices, userPractices, practiceSessions } from '@/api';
import { colors, SPACING, BORDER_RADIUS, shadows } from '@/design/tokens';
import { useAppNavigation, useAppRoute } from '@/navigation/hooks';

type ScreenView = 'selection' | 'timer' | 'summary' | 'reflection';

const DEFAULT_STAGE_NUMBER = 1;

// --- Hook: practice list state ---

function usePracticeListState() {
  const [availablePractices, setAvailablePractices] = useState<PracticeItem[]>([]);
  const [activeUserPractice, setActiveUserPractice] = useState<UserPractice | null>(null);
  const [selectedPractice, setSelectedPractice] = useState<PracticeItem | null>(null);
  const [weekCount, setWeekCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const incrementWeekCount = useCallback(() => setWeekCount((prev) => prev + 1), []);

  return {
    availablePractices,
    setAvailablePractices,
    activeUserPractice,
    setActiveUserPractice,
    selectedPractice,
    setSelectedPractice,
    weekCount,
    setWeekCount,
    isLoading,
    setIsLoading,
    error,
    setError,
    incrementWeekCount,
  };
}

// --- Hook: load practice data ---

function usePracticeSelect(
  stageNumber: number,
  availablePractices: PracticeItem[],
  setActiveUserPractice: (_up: UserPractice) => void,
  setSelectedPractice: (_p: PracticeItem | null) => void,
  setError: (_e: string | null) => void,
) {
  return useCallback(
    async (practiceId: number) => {
      try {
        const newUp = await userPractices.create({
          practice_id: practiceId,
          stage_number: stageNumber,
        });
        setActiveUserPractice(newUp);
        const matching = availablePractices.find((p) => p.id === practiceId);
        if (matching) setSelectedPractice(matching);
      } catch {
        setError('Failed to select practice. Please try again.');
      }
    },
    [stageNumber, availablePractices, setActiveUserPractice, setSelectedPractice, setError],
  );
}

function useLoadPracticeData(stageNumber: number, state: ReturnType<typeof usePracticeListState>) {
  const {
    setIsLoading,
    setError,
    setAvailablePractices,
    setWeekCount,
    setActiveUserPractice,
    setSelectedPractice,
  } = state;

  return useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [practiceList, userPracticeList, weekResult] = await Promise.all([
        practices.list(stageNumber),
        userPractices.list(),
        practiceSessions.weekCount(),
      ]);
      setAvailablePractices(practiceList);
      setWeekCount(weekResult.count);
      const active = userPracticeList.find((up: UserPractice) => up.stage_number === stageNumber);
      if (active) {
        setActiveUserPractice(active);
        const match = practiceList.find((p: PracticeItem) => p.id === active.practice_id);
        if (match) setSelectedPractice(match);
      }
    } catch {
      setError('Failed to load practices. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [
    stageNumber,
    setIsLoading,
    setError,
    setAvailablePractices,
    setWeekCount,
    setActiveUserPractice,
    setSelectedPractice,
  ]);
}

function usePracticeLoader(stageNumber: number) {
  const state = usePracticeListState();
  const loadData = useLoadPracticeData(stageNumber, state);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSelectPractice = usePracticeSelect(
    stageNumber,
    state.availablePractices,
    state.setActiveUserPractice,
    state.setSelectedPractice,
    state.setError,
  );

  return { ...state, loadData, handleSelectPractice };
}

// --- Hook: session save/reflection flow ---

function useSessionFlow(activeUserPractice: UserPractice | null, incrementWeekCount: () => void) {
  const [completedMinutes, setCompletedMinutes] = useState(0);
  const [savedSession, setSavedSession] = useState<PracticeSessionResponse | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSaveSession = useCallback(async () => {
    if (!activeUserPractice) return;
    setIsSaving(true);
    try {
      const payload: PracticeSessionCreate = {
        user_practice_id: activeUserPractice.id,
        duration_minutes: completedMinutes,
      };
      const session = await practiceSessions.create(payload);
      incrementWeekCount();
      setSavedSession(session);
    } catch {
      setError('Failed to save session. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [activeUserPractice, completedMinutes, incrementWeekCount]);

  const clearSession = useCallback(() => {
    setSavedSession(null);
  }, []);

  return {
    completedMinutes,
    setCompletedMinutes,
    savedSession,
    isSaving,
    saveError: error,
    handleSaveSession,
    clearSession,
  };
}

// --- Sub-components ---

const LoadingView = (): React.JSX.Element => (
  <View style={localStyles.centered} testID="practice-loading">
    <ActivityIndicator size="large" color={colors.primary} />
  </View>
);

const ErrorView = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): React.JSX.Element => (
  <View style={localStyles.centered} testID="practice-error">
    <Text style={localStyles.errorText}>{error}</Text>
    <TouchableOpacity style={localStyles.retryButton} onPress={onRetry} testID="retry-button">
      <Text style={localStyles.retryButtonText}>Retry</Text>
    </TouchableOpacity>
  </View>
);

interface TimerViewProps {
  practiceName: string;
  durationMinutes: number;
  onComplete: (_minutes: number) => void;
  onCancel: () => void;
}

const TimerView = ({
  practiceName,
  durationMinutes,
  onComplete,
  onCancel,
}: TimerViewProps): React.JSX.Element => (
  <View style={localStyles.timerContainer} testID="timer-view">
    <Text style={localStyles.timerTitle}>{practiceName}</Text>
    <PracticeTimer durationMinutes={durationMinutes} onComplete={onComplete} onCancel={onCancel} />
  </View>
);

interface SummaryViewProps {
  completedMinutes: number;
  isSaving: boolean;
  onSave: () => void;
  onSkip: () => void;
}

const SummaryView = ({
  completedMinutes,
  isSaving,
  onSave,
  onSkip,
}: SummaryViewProps): React.JSX.Element => (
  <View style={localStyles.centered} testID="summary-view">
    <Text style={localStyles.summaryTitle}>Practice Complete</Text>
    <Text style={localStyles.summaryDuration} testID="summary-duration">
      {completedMinutes} minutes
    </Text>
    <TouchableOpacity
      style={localStyles.saveButton}
      onPress={onSave}
      disabled={isSaving}
      testID="save-session-button"
    >
      <Text style={localStyles.saveButtonText}>{isSaving ? 'Saving...' : 'Save Session'}</Text>
    </TouchableOpacity>
    <TouchableOpacity style={localStyles.skipButton} onPress={onSkip} testID="skip-save-button">
      <Text style={localStyles.skipButtonText}>Skip</Text>
    </TouchableOpacity>
  </View>
);

const ReflectionView = ({
  onWrite,
  onSkip,
}: {
  onWrite: () => void;
  onSkip: () => void;
}): React.JSX.Element => (
  <View style={localStyles.centered} testID="reflection-view">
    <Text style={localStyles.summaryTitle}>Write a Reflection?</Text>
    <Text style={localStyles.summaryDuration}>
      Capture your thoughts from this practice session in your journal.
    </Text>
    <TouchableOpacity
      style={localStyles.saveButton}
      onPress={onWrite}
      testID="write-reflection-button"
    >
      <Text style={localStyles.saveButtonText}>Yes, Write a Reflection</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={localStyles.skipButton}
      onPress={onSkip}
      testID="skip-reflection-button"
    >
      <Text style={localStyles.skipButtonText}>Skip</Text>
    </TouchableOpacity>
  </View>
);

interface SelectionViewProps {
  weekCount: number;
  selectedPractice: PracticeItem | null;
  activeUserPractice: UserPractice | null;
  availablePractices: PracticeItem[];
  onStartTimer: () => void;
  onSelectPractice: (_id: number) => void;
}

const SelectionView = ({
  weekCount,
  selectedPractice,
  activeUserPractice,
  availablePractices,
  onStartTimer,
  onSelectPractice,
}: SelectionViewProps): React.JSX.Element => (
  <ScrollView style={localStyles.screen} testID="selection-view">
    <WeeklyProgress count={weekCount} />
    {selectedPractice && activeUserPractice ? (
      <View style={localStyles.activePractice} testID="active-practice-card">
        <Text style={localStyles.activePracticeLabel}>Your Practice</Text>
        <Text style={localStyles.activePracticeName}>{selectedPractice.name}</Text>
        <Text style={localStyles.activePracticeDesc}>{selectedPractice.description}</Text>
        <TouchableOpacity
          style={localStyles.startButton}
          onPress={onStartTimer}
          testID="start-practice-button"
        >
          <Text style={localStyles.startButtonText}>Start Practice</Text>
        </TouchableOpacity>
      </View>
    ) : (
      <PracticeSelector
        practices={availablePractices}
        selectedPracticeId={activeUserPractice?.practice_id ?? null}
        onSelect={onSelectPractice}
        isLoading={false}
      />
    )}
  </ScrollView>
);

// --- Hook: view routing ---

function usePracticeView(
  loader: ReturnType<typeof usePracticeLoader>,
  session: ReturnType<typeof useSessionFlow>,
) {
  const navigation = useAppNavigation();
  const [view, setView] = useState<ScreenView>('selection');
  const { setCompletedMinutes, handleSaveSession, clearSession, savedSession, completedMinutes } =
    session;
  const { selectedPractice } = loader;

  const handleTimerComplete = useCallback(
    (actualMinutes: number) => {
      setCompletedMinutes(actualMinutes);
      setView('summary');
    },
    [setCompletedMinutes],
  );

  const handleSaveAndAdvance = useCallback(async () => {
    await handleSaveSession();
    setView('reflection');
  }, [handleSaveSession]);

  const goToSelection = useCallback(() => {
    clearSession();
    setView('selection');
  }, [clearSession]);

  const handleWriteReflection = useCallback(() => {
    if (!savedSession || !selectedPractice) return;
    navigation.navigate('Journal', {
      practiceSessionId: savedSession.id,
      userPracticeId: savedSession.user_practice_id,
      practiceName: selectedPractice.name,
      practiceDuration: completedMinutes,
    });
    clearSession();
    setView('selection');
  }, [savedSession, selectedPractice, completedMinutes, clearSession, navigation]);

  return {
    view,
    setView,
    handleTimerComplete,
    handleSaveAndAdvance,
    goToSelection,
    handleWriteReflection,
  };
}

// --- View router ---

function PracticeViewRouter({
  loader,
  session,
  pv,
}: {
  loader: ReturnType<typeof usePracticeLoader>;
  session: ReturnType<typeof useSessionFlow>;
  pv: ReturnType<typeof usePracticeView>;
}): React.JSX.Element {
  if (pv.view === 'timer' && loader.selectedPractice) {
    return (
      <TimerView
        practiceName={loader.selectedPractice.name}
        durationMinutes={loader.selectedPractice.default_duration_minutes}
        onComplete={pv.handleTimerComplete}
        onCancel={pv.goToSelection}
      />
    );
  }

  if (pv.view === 'summary') {
    return (
      <SummaryView
        completedMinutes={session.completedMinutes}
        isSaving={session.isSaving}
        onSave={pv.handleSaveAndAdvance}
        onSkip={pv.goToSelection}
      />
    );
  }

  if (pv.view === 'reflection') {
    return <ReflectionView onWrite={pv.handleWriteReflection} onSkip={pv.goToSelection} />;
  }

  return (
    <SelectionView
      weekCount={loader.weekCount}
      selectedPractice={loader.selectedPractice}
      activeUserPractice={loader.activeUserPractice}
      availablePractices={loader.availablePractices}
      onStartTimer={() => pv.setView('timer')}
      onSelectPractice={loader.handleSelectPractice}
    />
  );
}

// --- Main component ---

const PracticeScreen = (): React.JSX.Element => {
  const route = useAppRoute<'Practice'>();
  const stageNumber = route.params?.stageNumber ?? DEFAULT_STAGE_NUMBER;
  const loader = usePracticeLoader(stageNumber);
  const session = useSessionFlow(loader.activeUserPractice, loader.incrementWeekCount);
  const pv = usePracticeView(loader, session);

  const combinedError = loader.error ?? session.saveError;

  if (loader.isLoading && pv.view === 'selection') return <LoadingView />;
  if (combinedError) return <ErrorView error={combinedError} onRetry={loader.loadData} />;

  return <PracticeViewRouter loader={loader} session={session} pv={pv} />;
};

const localStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
    backgroundColor: colors.background.primary,
  },
  timerContainer: {
    flex: 1,
    backgroundColor: colors.background.primary,
    paddingTop: SPACING.xxl,
    alignItems: 'center',
  },
  timerTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: SPACING.lg,
    textAlign: 'center',
  },
  activePractice: {
    margin: SPACING.lg,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    ...shadows.medium,
  },
  activePracticeLabel: {
    fontSize: 13,
    color: colors.text.tertiary,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: SPACING.xs,
  },
  activePracticeName: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
  },
  activePracticeDesc: {
    fontSize: 15,
    color: colors.text.secondary,
    lineHeight: 22,
    marginBottom: SPACING.lg,
  },
  startButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  startButtonText: {
    color: colors.text.light,
    fontSize: 17,
    fontWeight: '600',
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
  retryButtonText: {
    color: colors.text.light,
    fontWeight: '600',
  },
  summaryTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.md,
  },
  summaryDuration: {
    fontSize: 18,
    color: colors.text.secondary,
    marginBottom: SPACING.xxl,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xxl,
    marginBottom: SPACING.md,
    minWidth: 200,
    alignItems: 'center',
  },
  saveButtonText: {
    color: colors.text.light,
    fontSize: 17,
    fontWeight: '600',
  },
  skipButton: {
    paddingVertical: SPACING.sm,
  },
  skipButtonText: {
    color: colors.text.tertiary,
    fontSize: 15,
  },
});

export default PracticeScreen;
