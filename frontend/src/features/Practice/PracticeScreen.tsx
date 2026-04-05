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

const PracticeScreen = (): React.JSX.Element => {
  const navigation = useAppNavigation();
  const route = useAppRoute<'Practice'>();
  const stageNumber = route.params?.stageNumber ?? DEFAULT_STAGE_NUMBER;
  const [view, setView] = useState<ScreenView>('selection');

  // Data
  const [availablePractices, setAvailablePractices] = useState<PracticeItem[]>([]);
  const [activeUserPractice, setActiveUserPractice] = useState<UserPractice | null>(null);
  const [selectedPractice, setSelectedPractice] = useState<PracticeItem | null>(null);
  const [weekCount, setWeekCount] = useState(0);
  const [completedMinutes, setCompletedMinutes] = useState(0);
  const [savedSession, setSavedSession] = useState<PracticeSessionResponse | null>(null);

  // Loading states
  const [isLoadingPractices, setIsLoadingPractices] = useState(true);
  const [isSavingSession, setIsSavingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoadingPractices(true);
    setError(null);
    try {
      const [practiceList, userPracticeList, weekResult] = await Promise.all([
        practices.list(stageNumber),
        userPractices.list(),
        practiceSessions.weekCount(),
      ]);

      setAvailablePractices(practiceList);
      setWeekCount(weekResult.count);

      // Find user's active practice for the current stage
      const activePractice = userPracticeList.find(
        (up: UserPractice) => up.stage_number === stageNumber,
      );
      if (activePractice) {
        setActiveUserPractice(activePractice);
        const matchingPractice = practiceList.find(
          (p: PracticeItem) => p.id === activePractice.practice_id,
        );
        if (matchingPractice) {
          setSelectedPractice(matchingPractice);
        }
      }
    } catch {
      setError('Failed to load practices. Please try again.');
    } finally {
      setIsLoadingPractices(false);
    }
  }, [stageNumber]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSelectPractice = useCallback(
    async (practiceId: number) => {
      try {
        const newUserPractice = await userPractices.create({
          practice_id: practiceId,
          stage_number: stageNumber,
        });
        setActiveUserPractice(newUserPractice);
        const matching = availablePractices.find((p) => p.id === practiceId);
        if (matching) {
          setSelectedPractice(matching);
        }
      } catch {
        setError('Failed to select practice. Please try again.');
      }
    },
    [stageNumber, availablePractices],
  );

  const handleStartTimer = useCallback(() => {
    setView('timer');
  }, []);

  const handleTimerComplete = useCallback((actualMinutes: number) => {
    setCompletedMinutes(actualMinutes);
    setView('summary');
  }, []);

  const handleTimerCancel = useCallback(() => {
    setView('selection');
  }, []);

  const handleSaveSession = useCallback(async () => {
    if (!activeUserPractice) return;
    setIsSavingSession(true);
    try {
      const payload: PracticeSessionCreate = {
        user_practice_id: activeUserPractice.id,
        duration_minutes: completedMinutes,
      };
      const session = await practiceSessions.create(payload);
      setWeekCount((prev) => prev + 1);
      setSavedSession(session);
      setView('reflection');
    } catch {
      setError('Failed to save session. Please try again.');
    } finally {
      setIsSavingSession(false);
    }
  }, [activeUserPractice, completedMinutes]);

  const handleWriteReflection = useCallback(() => {
    if (!savedSession || !selectedPractice) return;
    navigation.navigate('Journal', {
      practiceSessionId: savedSession.id,
      userPracticeId: savedSession.user_practice_id,
      practiceName: selectedPractice.name,
      practiceDuration: completedMinutes,
    });
    setSavedSession(null);
    setView('selection');
  }, [savedSession, selectedPractice, completedMinutes, navigation]);

  const handleSkipReflection = useCallback(() => {
    setSavedSession(null);
    setView('selection');
  }, []);

  if (isLoadingPractices && view === 'selection') {
    return (
      <View style={styles.centered} testID="practice-loading">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered} testID="practice-error">
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={loadData} testID="retry-button">
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (view === 'timer' && selectedPractice) {
    return (
      <View style={styles.timerContainer} testID="timer-view">
        <Text style={styles.timerTitle}>{selectedPractice.name}</Text>
        <PracticeTimer
          durationMinutes={selectedPractice.default_duration_minutes}
          onComplete={handleTimerComplete}
          onCancel={handleTimerCancel}
        />
      </View>
    );
  }

  if (view === 'summary') {
    return (
      <View style={styles.centered} testID="summary-view">
        <Text style={styles.summaryTitle}>Practice Complete</Text>
        <Text style={styles.summaryDuration} testID="summary-duration">
          {completedMinutes} minutes
        </Text>
        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSaveSession}
          disabled={isSavingSession}
          testID="save-session-button"
        >
          <Text style={styles.saveButtonText}>
            {isSavingSession ? 'Saving...' : 'Save Session'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.skipButton}
          onPress={() => setView('selection')}
          testID="skip-save-button"
        >
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (view === 'reflection') {
    return (
      <View style={styles.centered} testID="reflection-view">
        <Text style={styles.summaryTitle}>Write a Reflection?</Text>
        <Text style={styles.summaryDuration}>
          Capture your thoughts from this practice session in your journal.
        </Text>
        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleWriteReflection}
          testID="write-reflection-button"
        >
          <Text style={styles.saveButtonText}>Yes, Write a Reflection</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.skipButton}
          onPress={handleSkipReflection}
          testID="skip-reflection-button"
        >
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Selection view
  return (
    <ScrollView style={styles.screen} testID="selection-view">
      <WeeklyProgress count={weekCount} />

      {selectedPractice && activeUserPractice ? (
        <View style={styles.activePractice} testID="active-practice-card">
          <Text style={styles.activePracticeLabel}>Your Practice</Text>
          <Text style={styles.activePracticeName}>{selectedPractice.name}</Text>
          <Text style={styles.activePracticeDesc}>{selectedPractice.description}</Text>
          <TouchableOpacity
            style={styles.startButton}
            onPress={handleStartTimer}
            testID="start-practice-button"
          >
            <Text style={styles.startButtonText}>Start Practice</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <PracticeSelector
          practices={availablePractices}
          selectedPracticeId={activeUserPractice?.practice_id ?? null}
          onSelect={handleSelectPractice}
          isLoading={false}
        />
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
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
