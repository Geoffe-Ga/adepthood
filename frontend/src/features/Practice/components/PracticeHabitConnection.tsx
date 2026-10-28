import React, { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import PracticeHabitSessionProvider, {
  type PracticeHabitBindings,
  type PracticeHabitOption,
} from './PracticeHabitSessionProvider';

import { captureSessionToken } from '@/api';
import { BORDER_RADIUS, SPACING, colors, editorialType, surface } from '@/design/tokens';
import type { HabitGoalSetup } from '@/features/Habits/Habits.types';
import { habitManager } from '@/features/Habits/services/habitManager';
import { isTimerLinkableHabit } from '@/features/Habits/timerHabit';
import { writingGoalDraft } from '@/features/Journal/journalHabitDefaults';
import OfferAction from '@/features/Journal/OfferAction';
import WritingHabitGoalEditor from '@/features/Journal/WritingHabitGoalEditor';
import { PRACTICE_HABIT_DEFAULTS } from '@/features/Practice/constants';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';
import { decodeJwtPayload } from '@/utils/token';

type ProviderProps = ComponentProps<typeof PracticeHabitSessionProvider>;
type Props = Omit<ProviderProps, 'bindings'> & { bindings?: PracticeHabitBindings };
interface Creation {
  name: string;
  link: (_option: PracticeHabitOption) => Promise<boolean>;
}

function eligibleOptions(): PracticeHabitOption[] {
  return useHabitStore
    .getState()
    .habits.filter(isTimerLinkableHabit)
    .map((habit) => ({
      habit,
      unit: habit.goals[0]!.target_unit as 'minutes' | 'sessions',
    }));
}
function practiceDraft(name: string) {
  const draft = writingGoalDraft();
  return {
    ...draft,
    name,
    goals: draft.goals.map((goal) => ({
      ...goal,
      target: PRACTICE_HABIT_DEFAULTS[goal.tier],
      target_unit: PRACTICE_HABIT_DEFAULTS.unit,
      frequency: PRACTICE_HABIT_DEFAULTS.frequency,
      frequency_unit: PRACTICE_HABIT_DEFAULTS.frequencyUnit,
    })),
  };
}
function useCurrentOwner() {
  const { owner, generation } = useRef({
    owner: getActiveUser(),
    generation: getActiveUserGeneration(),
  }).current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => {
    const token = captureSessionToken();
    return (
      mounted.current &&
      parseUserId(owner) !== null &&
      getActiveUser() === owner &&
      getActiveUserGeneration() === generation &&
      token !== undefined &&
      parseUserId(decodeJwtPayload(token)?.sub) === owner
    );
  }, [owner, generation]);
}

function insertPracticeHabit(name: string, goals: HabitGoalSetup, timezone: string) {
  return habitManager.insertHabitAtWithId(
    { name, icon: '🧘', goals, revealed: true },
    useHabitStore.getState().habits.length,
    timezone,
  );
}

/** A saved row has one link request at a time, including synchronous repeat presses. */
function useSavedLink(creation: Creation | null, current: () => boolean, close: () => void) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async (option: PracticeHabitOption) => {
    if (!creation || !current() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (await creation.link(option)) {
        if (current()) close();
      } else if (current())
        setError('Habit saved. We could not confirm its practice link. Try linking it again.');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  return { busy, error, link, pending, clear: () => setError(null) };
}

/** Creation uses the shared atomic ladder; a refused link retries that same saved row. */
function useCreation(timezone: string, current: () => boolean) {
  const [creation, setCreation] = useState<Creation | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PracticeHabitOption | null>(null);
  const linking = useSavedLink(creation, current, () => setCreation(null));
  const save = async (setup: HabitGoalSetup) => {
    if (!creation || pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await insertPracticeHabit(creation.name, setup, timezone);
      if (!current()) return;
      const option = eligibleOptions().find((item) => item.habit.id === result.habitId);
      if (!result.kept || !option) throw new Error('No confirmed eligible habit');
      setSaved(option);
      await linking.link(option);
    } catch {
      if (current()) setError('We could not confirm this habit. Check Habits before trying again.');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  return {
    creation,
    busy: busy || linking.busy,
    error: error ?? linking.error,
    saved,
    save,
    link: linking.link,
    cancel: () => {
      if (current() && !pending.current && !linking.pending.current) setCreation(null);
    },
    open: (name: string, callback: Creation['link']) => {
      if (!current()) return;
      setSaved(null);
      setError(null);
      linking.clear();
      setCreation({ name, link: callback });
    },
  };
}

function SavedLinkActions({
  model,
  option,
}: {
  model: ReturnType<typeof useCreation>;
  option: PracticeHabitOption;
}) {
  return (
    <>
      <OfferAction
        label={model.busy ? 'Linking habit…' : 'Link saved habit'}
        disabled={model.busy}
        a11yLabel="Link the habit already saved"
        onPress={() => {
          void model.link(option);
        }}
        testID="practice-habit-retry-link"
      />
      <OfferAction
        label="Close"
        disabled={model.busy}
        a11yLabel="Close the saved habit form"
        testID="practice-habit-created-close"
        onPress={model.cancel}
      />
    </>
  );
}

function CreationSheet({ model }: { model: ReturnType<typeof useCreation> }) {
  if (!model.creation) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={model.cancel}>
      <View style={styles.backdrop}>
        <ScrollView
          testID="practice-habit-creation"
          style={styles.card}
          contentContainerStyle={styles.content}
          accessibilityViewIsModal
        >
          <Text accessibilityRole="header" style={styles.title}>
            New habit: {model.creation.name}
          </Text>
          {model.error && (
            <Text accessibilityLiveRegion="polite" style={styles.copy}>
              {model.error}
            </Text>
          )}
          {model.saved ? (
            <SavedLinkActions model={model} option={model.saved} />
          ) : (
            <WritingHabitGoalEditor
              habit={practiceDraft(model.creation.name)}
              onSave={(setup) => {
                void model.save(setup);
              }}
              onCancel={model.cancel}
              busy={model.busy}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
function CanonicalConnection(props: Omit<Props, 'bindings'>) {
  const habits = useHabitStore((state) => state.habits);
  const current = useCurrentOwner();
  const creation = useCreation(props.timezone, current);
  useEffect(() => {
    if (current()) void habitManager.loadHabits(props.timezone);
  }, [current, props.timezone]);
  if (!current()) return <>{props.children}</>;
  const bindings: PracticeHabitBindings = {
    options: habits.filter(isTimerLinkableHabit).map((habit) => ({
      habit,
      unit: habit.goals[0]!.target_unit as 'minutes' | 'sessions',
    })),
    refresh: () => habitManager.refreshHabits(props.timezone),
    currentOptions: eligibleOptions,
    manager: habitManager,
    onNewHabit: creation.open,
  };
  return (
    <>
      <PracticeHabitSessionProvider {...props} bindings={bindings} />
      <CreationSheet model={creation} />
    </>
  );
}
export default function PracticeHabitConnection(props: Props) {
  return props.bindings ? (
    <PracticeHabitSessionProvider {...props} bindings={props.bindings} />
  ) : (
    <CanonicalConnection {...props} />
  );
}
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
    backgroundColor: colors.mystical.overlay,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
    flexGrow: 0,
  },
  content: { padding: SPACING.md, gap: SPACING.sm },
  title: { ...editorialType.note, color: colors.paper.ink },
  copy: { ...editorialType.caption, color: colors.paper.inkSoft },
});
