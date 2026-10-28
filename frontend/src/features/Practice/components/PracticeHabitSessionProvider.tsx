import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import OfferAction from './PracticeHabitAction';
import PracticeHabitOffer from './PracticeHabitOffer';
import PracticeHabitPicker from './PracticeHabitPicker';

import {
  captureSessionToken,
  type PracticeSessionCreate,
  type PracticeSessionResponse,
  type UserPractice,
} from '@/api';
import { editorialType, onShowcase, SPACING } from '@/design/tokens';
import type { Habit } from '@/features/Habits/Habits.types';
import { usePracticeHabitLink } from '@/features/Practice/hooks/usePracticeHabitLink';
import type { UseSaveSessionMutationParams } from '@/features/Practice/hooks/useSaveSessionMutation';
import {
  logCompletedPracticeHabit,
  type PracticeHabitLogInput,
  type PreparedPracticeHabitLog,
  type TimerHabitLogService,
} from '@/features/Practice/practiceHabitLogging';
import { useActiveUserGeneration } from '@/storage/useActiveUser';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** Options come from the qualified shared timer predicate, never a second goal ladder. */
export interface PracticeHabitOption {
  habit: Habit;
  unit: 'minutes' | 'sessions';
}
export interface PracticeHabitBindings {
  /** The eligible habits as of this render, for the link facts and picker. */
  options: readonly PracticeHabitOption[];
  /** Re-read the owner's habits from the server; false when the server could not answer. */
  refresh: () => Promise<boolean>;
  /** The eligible habits as held right now, which a refresh may have changed since render. */
  currentOptions: () => readonly PracticeHabitOption[];
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
  /** Re-attempt a sitting's habit log the current owner could not complete. */
  retry: (() => void) | null;
  adoptionId: number;
  hasLink: boolean;
}
interface Scope {
  current: () => boolean;
  viewCurrent: () => boolean;
  ownerCurrent: () => boolean;
  latest: () => Props;
  /** The account generation this render belongs to. */
  generation: number;
}
const Context = createContext<Controller | null>(null);
export const usePracticeHabitSession = (): Controller | null => useContext(Context);

function useControllerScope(props: Props): Scope {
  // Subscribing re-renders on an account switch, so a picker held open by a
  // pending link change (which cannot be dismissed, #3382) closes with the
  // outgoing owner instead of waiting on a write whose result is fenced off.
  const generation = useActiveUserGeneration();
  const owner = getActiveUser();
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
  return { current, viewCurrent, ownerCurrent, latest: () => live.current.props, generation };
}

interface Sitting {
  session: PracticeSessionResponse;
  payload: PracticeSessionCreate;
  viaTimer: boolean;
  /** The habit's name as this screen last knew it, for a notice when it cannot be read now. */
  name: string;
  /** A failed attempt's prepared log, retried under its original operation id and unit. */
  failed?: PreparedPracticeHabitLog;
}
const SAVED = 'Your practice is saved.';
const unavailableNotice = (name: string) =>
  `Couldn't confirm the current goal for ${name}, so this sitting isn't logged there yet. ${SAVED}`;
const ineligibleNotice = (name: string) =>
  `This sitting wasn't logged to ${name}: it is no longer a habit that counts minutes or sessions. ${SAVED}`;
const changedNotice = (name: string) =>
  `This sitting wasn't logged to ${name}: its goal unit changed after the first try. ${SAVED}`;

/** Read the owner's habits from the server now; a cached option never sets the posted unit. */
async function refreshedOption(
  bindings: PracticeHabitBindings,
  habitId: number,
): Promise<PracticeHabitOption | null | 'unavailable'> {
  const fresh = await bindings.refresh().catch(() => false);
  if (!fresh) return 'unavailable';
  return bindings.currentOptions().find((item) => item.habit.id === habitId) ?? null;
}

type Tell = (_message: string, _again?: () => void) => void;
type TimerHabit = PracticeHabitLogInput['habit'];

/** The sitting the server saved for this adoption, as a completed one. */
function ownsSitting(
  session: PracticeSessionResponse,
  payload: PracticeSessionCreate,
  adoptionId: number,
): boolean {
  return (
    session.completed === true &&
    payload.completed === true &&
    session.id > 0 &&
    session.user_practice_id === adoptionId &&
    payload.user_practice_id === adoptionId
  );
}

/** A factual notice, with a retry only when the current owner can still make one. */
function useHabitNotice(scope: Scope) {
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const clear = (): void => {
    setNotice(null);
    setRetry(null);
  };
  const tell: Tell = (message, again) => {
    if (!scope.current()) return;
    setNotice(message);
    setRetry(again ? () => again : null);
  };
  return { notice, retry, tell, clear };
}

function logInput(
  props: Props,
  scope: Scope,
  sitting: Sitting,
  habit: TimerHabit,
): Omit<PracticeHabitLogInput, 'onNotice' | 'onFailed'> {
  return {
    session: sitting.session,
    payload: sitting.payload,
    habit,
    timezone: props.timezone,
    viaTimer: sitting.viaTimer,
    manager: props.bindings.manager,
    prepared: sitting.failed,
    // The commit waits its turn in the habit/day queue; the unit must still hold then.
    isCurrent: () =>
      scope.current() &&
      scope
        .latest()
        .bindings.currentOptions()
        .some((item) => item.habit.id === habit.id && item.unit === habit.unit),
    isOwnerCurrent: scope.ownerCurrent,
  };
}

/** Refresh, revalidate the current unit, then log; every unlogged outcome is said aloud. */
function useSittingLog(
  props: Props,
  scope: Scope,
  { tell, clear }: ReturnType<typeof useHabitNotice>,
) {
  const habitId = props.userPractice.habit_id ?? null;
  const retryOnce = (sitting: Sitting): void => {
    if (!scope.current() || habitId === null) return;
    clear();
    void attempt(sitting);
  };
  const attempt = async (sitting: Sitting): Promise<void> => {
    if (habitId === null) return;
    const option = await refreshedOption(scope.latest().bindings, habitId);
    if (!scope.current()) return;
    if (option === 'unavailable')
      return tell(unavailableNotice(sitting.name), () => retryOnce(sitting));
    if (!option) return tell(ineligibleNotice(sitting.name));
    if (sitting.failed && sitting.failed.unit !== option.unit)
      return tell(changedNotice(option.habit.name));
    const habit = { id: option.habit.id, name: option.habit.name, unit: option.unit };
    await logCompletedPracticeHabit({
      ...logInput(props, scope, sitting, habit),
      onNotice: (message) => tell(message),
      onFailed: (failed) => {
        const again = { ...sitting, name: habit.name, failed };
        tell(`Couldn't log to ${habit.name}`, () => retryOnce(again));
      },
    });
  };
  return attempt;
}

function useCompletedHabit(props: Props, scope: Scope) {
  const [completed, setCompleted] = useState(false);
  const notice = useHabitNotice(scope);
  const attempt = useSittingLog(props, scope, notice);
  const habitId = props.userPractice.habit_id ?? null;
  const onConfirmed: Controller['onConfirmed'] = async (session, payload, source = 'timer') => {
    if (!scope.current() || !ownsSitting(session, payload, props.userPractice.id)) return;
    if (habitId === null) {
      setCompleted(true);
      return;
    }
    const known = scope.latest().bindings.options.find((item) => item.habit.id === habitId);
    const name = known?.habit.name ?? 'your linked habit';
    await attempt({ session, payload, viaTimer: source === 'timer', name });
  };
  return {
    completed,
    notice: notice.notice,
    retry: notice.retry,
    onConfirmed,
    clearNotice: notice.clear,
  };
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
  // The picker belongs to the account generation that opened it, so an A→B→A
  // switch never revives a picker the outgoing session left open (#3382).
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const pickerOpen = pickerFor === scope.generation;
  const setPickerOpen = (open: boolean): void => setPickerFor(open ? scope.generation : null);
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
      {controller.retry && (
        <OfferAction
          label="Try logging again"
          a11yLabel="Try logging this sitting to its linked habit again"
          testID="practice-habit-retry-log"
          onPress={controller.retry}
        />
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
