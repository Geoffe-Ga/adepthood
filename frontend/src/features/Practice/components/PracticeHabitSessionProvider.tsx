import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import OfferAction from './PracticeHabitAction';
import PracticeHabitOffer from './PracticeHabitOffer';
import PracticeHabitPicker from './PracticeHabitPicker';

import { captureSessionToken, type UserPractice } from '@/api';
import { editorialType, onShowcase, SPACING } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import { usePracticeHabitLink } from '@/features/Practice/hooks/usePracticeHabitLink';
import type { UseSaveSessionMutationParams } from '@/features/Practice/hooks/useSaveSessionMutation';
import {
  logCompletedPracticeHabit,
  type TimerHabitLogService,
} from '@/features/Practice/practiceHabitLogging';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** Options come from the qualified shared timer predicate, never a second goal ladder. */
export interface PracticeHabitOption {
  habit: Habit;
  unit: 'minutes' | 'sessions';
}
export interface PracticeHabitBindings {
  options: readonly PracticeHabitOption[];
  manager: TimerHabitLogService;
  onNewHabit: (
    _name: string,
    _linkConfirmed: (_option: PracticeHabitOption) => Promise<boolean>,
  ) => void;
}
interface Props {
  userPractice: UserPractice;
  practiceName: string;
  timezone: string;
  bindings: PracticeHabitBindings;
  onUpdated: (_next: UserPractice) => void;
  children: React.ReactNode;
}
interface Controller {
  onConfirmed: NonNullable<UseSaveSessionMutationParams['onConfirmed']>;
  openPicker: () => void;
  linked: PracticeHabitOption | null;
  completed: boolean;
  notice: string | null;
  adoptionId: number;
  hasLink: boolean;
}
interface Scope {
  current: () => boolean;
  viewCurrent: () => boolean;
  ownerCurrent: () => boolean;
  latest: () => Props;
}
const Context = createContext<Controller | null>(null);
export const usePracticeHabitSession = (): Controller | null => useContext(Context);

function useControllerScope(props: Props): Scope {
  const owner = getActiveUser();
  const generation = getActiveUserGeneration();
  const live = useRef({ props, mounted: true });
  live.current.props = props;
  useEffect(() => {
    const instance = live.current;
    instance.mounted = true;
    return () => {
      instance.mounted = false;
    };
  }, []);
  const ownerCurrent = (): boolean => {
    const token = captureSessionToken();
    return (
      parseUserId(owner) !== null &&
      getActiveUser() === owner &&
      getActiveUserGeneration() === generation &&
      token !== undefined &&
      parseUserId(decodeJwtPayload(token)?.sub) === owner
    );
  };
  const viewCurrent = (): boolean =>
    live.current.mounted &&
    ownerCurrent() &&
    live.current.props.userPractice.id === props.userPractice.id &&
    live.current.props.bindings.manager === props.bindings.manager;
  const current = (): boolean =>
    viewCurrent() &&
    (live.current.props.userPractice.habit_id ?? null) === (props.userPractice.habit_id ?? null);
  return { current, viewCurrent, ownerCurrent, latest: () => live.current.props };
}

function useCompletedHabit(props: Props, scope: Scope) {
  const [completed, setCompleted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const adoptionId = props.userPractice.id;
  const habitId = props.userPractice.habit_id ?? null;
  const onConfirmed: Controller['onConfirmed'] = async (session, payload, source = 'timer') => {
    if (
      !scope.current() ||
      !session.completed ||
      !payload.completed ||
      session.id <= 0 ||
      session.user_practice_id !== adoptionId ||
      payload.user_practice_id !== adoptionId
    )
      return;
    if (habitId === null) setCompleted(true);
    const option = scope.latest().bindings.options.find((item) => item.habit.id === habitId);
    if (!option) return;
    await logCompletedPracticeHabit({
      session,
      payload,
      habit: { id: option.habit.id, name: option.habit.name, unit: option.unit },
      timezone: props.timezone,
      viaTimer: source === 'timer',
      manager: props.bindings.manager,
      isCurrent: () =>
        scope.current() &&
        scope
          .latest()
          .bindings.options.some(
            (item) => item.habit.id === option.habit.id && item.unit === option.unit,
          ),
      isOwnerCurrent: scope.ownerCurrent,
      onNotice: (message) => {
        if (scope.current()) setNotice(message);
      },
    });
  };
  return { completed, notice, onConfirmed, clearNotice: () => setNotice(null) };
}

type SetPicker = (_open: boolean) => void;
function useLinkActions(props: Props, scope: Scope, setOpen: SetPicker, clearNotice: () => void) {
  const link = usePracticeHabitLink({
    userPractice: props.userPractice,
    onUpdated: props.onUpdated,
  });
  const choose = async (option: PracticeHabitOption): Promise<boolean> => {
    if (
      !scope.current() ||
      parseUserId(option.habit.id) === null ||
      option.habit.isDemoSeed ||
      option.habit.hasClientMintedIds
    )
      return false;
    const saved = await link.save(option.habit.id);
    if (saved && scope.viewCurrent()) setOpen(false);
    return saved;
  };
  const clear = async (): Promise<void> => {
    if (scope.current() && (await link.save(null)) && scope.viewCurrent()) {
      setOpen(false);
      clearNotice();
    }
  };
  const chooseHabit = (habit: Habit): void => {
    const option = scope.latest().bindings.options.find((item) => item.habit.id === habit.id);
    if (option) void choose(option);
  };
  return {
    busy: link.busy,
    error: link.error,
    onChoose: chooseHabit,
    onClear: () => {
      void clear();
    },
    onNew: () => {
      if (!scope.current()) return;
      setOpen(false);
      props.bindings.onNewHabit(props.practiceName, choose);
    },
    onCancel: () => {
      if (scope.viewCurrent()) setOpen(false);
    },
    openPicker: () => {
      if (scope.current()) setOpen(true);
    },
  };
}

/** One owner/adoption controller shared by the mounted timer and manual session writers. */
export default function PracticeHabitSessionProvider(props: Props): React.JSX.Element {
  const scope = useControllerScope(props);
  const completed = useCompletedHabit(props, scope);
  const [pickerOpen, setPickerOpen] = useState(false);
  const actions = useLinkActions(props, scope, setPickerOpen, completed.clearNotice);
  const habitId = props.userPractice.habit_id ?? null;
  const linked = props.bindings.options.find((option) => option.habit.id === habitId) ?? null;
  const controller = {
    ...completed,
    linked,
    hasLink: habitId !== null,
    adoptionId: props.userPractice.id,
    openPicker: actions.openPicker,
  };
  const admitted = scope.current();
  return (
    <Context.Provider value={admitted ? controller : null}>
      {props.children}
      {admitted && pickerOpen && (
        <PracticeHabitPicker
          practiceName={props.practiceName}
          habits={props.bindings.options.map((option) => option.habit)}
          onChoose={actions.onChoose}
          onNew={actions.onNew}
          onClear={habitId === null ? undefined : actions.onClear}
          onCancel={actions.onCancel}
          busy={actions.busy}
          error={actions.error}
        />
      )}
    </Context.Provider>
  );
}

/** Inline facts and the once-per-adoption offer; the modal preserves the session engine. */
export function PracticeHabitSessionControls(): React.JSX.Element | null {
  const controller = usePracticeHabitSession();
  if (!controller) return null;
  return (
    <View
      testID="practice-habit-controls"
      style={[styles.controls, controller.notice || controller.linked ? styles.facts : undefined]}
    >
      {controller.notice && (
        <Text accessibilityLiveRegion="polite" style={styles.copy}>
          {controller.notice}
        </Text>
      )}
      {controller.linked && (
        <>
          <Text testID="practice-linked-habit" style={styles.copy}>
            Linked to {controller.linked.habit.name}
          </Text>
          <OfferAction
            label="Change linked habit"
            a11yLabel="Choose or clear this practice's linked habit"
            testID="practice-habit-change"
            onPress={controller.openPicker}
          />
        </>
      )}
      {controller.completed && !controller.hasLink && (
        <PracticeHabitOffer adoptionId={controller.adoptionId} onLink={controller.openPicker} />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  controls: { gap: SPACING.xs },
  facts: { paddingVertical: SPACING.sm },
  copy: { ...editorialType.caption, color: onShowcase.soft },
});
