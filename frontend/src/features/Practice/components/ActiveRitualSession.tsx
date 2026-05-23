/**
 * `ActiveRitualSession` — composition shell rendered when the user has an
 * active practice for the current stage.
 *
 * Why a separate component (not inlined into `PracticeScreen`)? React hooks
 * cannot be conditional. The session machinery — `useRitualEngine`,
 * keep-awake activation, the insight-modal state, and the save-mutation
 * pipe — only makes sense when there is an `effectiveConfig`. Splitting it
 * here lets `PracticeScreen` decide between "selector" and "session" at
 * the component boundary instead of guarding every hook with a sentinel.
 *
 * Responsibilities:
 *   - Mount `useRitualEngine(effectiveConfig)` exactly once for the active
 *     session. Re-mounts when `effectiveConfig` changes (configurator
 *     save) via the parent's stable `key` prop.
 *   - Dispatch on `effectiveConfig.mode` to the correct mode view.
 *   - Harvest per-mode `SessionMetadata` (wire) and `ModeSummaryMetadata`
 *     (display) from engine state on completion.
 *   - Open the ritual-12 `InsightCaptureModal` on the `idle → … → complete`
 *     transition; never on cancel.
 *   - Drive the optimistic week-count increment via the parent-supplied
 *     `useWeeklyProgress` callbacks so the bar reconciles with server truth.
 *   - Activate keep-awake while the engine is `running` (not for the whole
 *     active-card lifetime).
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type {
  PracticeSessionCreate,
  PracticeSessionResponse,
  SessionMetadata,
  UserPractice,
} from '@/api';
import { practiceSessions } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { InsightCaptureModal } from '@/features/Practice/components/InsightCaptureModal';
import RitualConfiguratorSheet from '@/features/Practice/configurator/RitualConfiguratorSheet';
import type { PickedCard } from '@/features/Practice/data/resolveCard';
import { buildCardMeditationMetadata, pickCard } from '@/features/Practice/data/resolveCard';
import { cardForDayIndex } from '@/features/Practice/data/tarot';
import { scheduledCues } from '@/features/Practice/engine/cues';
import { totalSteps, totalStepsPerRound } from '@/features/Practice/engine/tallied';
import type {
  CardMeditationConfig,
  IntervalBellConfig,
  ModeConfig,
  RandomIntervalBellMetadata,
  RepCounterConfig,
  RitualControls,
  RitualState,
  SenseGroundingConfig,
  TalliedGroundingConfig,
  TarotConfig,
} from '@/features/Practice/engine/types';
import { useRitualEngine } from '@/features/Practice/engine/useRitualEngine';
import type { ModeSummaryKind, ModeSummaryMetadata } from '@/features/Practice/insights/format';
import CardMeditationView from '@/features/Practice/views/CardMeditationView';
import CountUpTimerView from '@/features/Practice/views/CountUpTimerView';
import IntervalBellView from '@/features/Practice/views/IntervalBellView';
import MeditationTimerView from '@/features/Practice/views/MeditationTimerView';
import MetronomeView from '@/features/Practice/views/MetronomeView';
import RandomIntervalBellView from '@/features/Practice/views/RandomIntervalBellView';
import RepCounterView from '@/features/Practice/views/RepCounterView';
import SenseGroundingView from '@/features/Practice/views/SenseGroundingView';
import TalliedGroundingView from '@/features/Practice/views/TalliedGroundingView';
import TarotMeditationView from '@/features/Practice/views/TarotMeditationView';
import { useOptimisticMutation } from '@/hooks/useOptimisticMutation';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60_000;
const TAROT_DECK_SIZE = 22;
const KEEP_AWAKE_TAG = 'ritual-engine';
const SAVE_FALLBACK =
  "We couldn't save your practice session. Check your connection and try again — your timer minutes are still safe here.";

export interface ActiveRitualSessionProps {
  userPractice: UserPractice;
  effectiveName: string;
  effectiveConfig: ModeConfig;
  userTimezone: string;
  /** Optimistic +1 on Save. */
  onSessionApply: () => void;
  /** Rollback on save failure. */
  onSessionRollback: () => void;
  /** Authoritative refetch after the server confirms the row. */
  onSessionCommitted: () => void;
  /** Replace the in-memory active row after the configurator saves. */
  onUserPracticeUpdated: (_next: UserPractice) => void;
  /** Open the journal-reflection composer (parent owns the navigator). */
  onWriteReflection: (_args: { session: PracticeSessionResponse; insight: string | null }) => void;
  /** Open the practice switcher from the card header. */
  onSwitchPractice: () => void;
}

interface ActiveSession {
  state: RitualState;
  controls: RitualControls;
  wireMetadata: SessionMetadata;
  summaryMetadata: ModeSummaryMetadata;
  tarotCardIndex: number;
  /** The card drawn for a `card_meditation` session; `null` for other modes. */
  cardPick: PickedCard | null;
  completedWindow: { start: Date; end: Date } | null;
  isSaving: boolean;
  saveError: string | null;
  /** Lifts the random-bell view's live schedule metadata for the harvest. */
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
  submitSession: (
    _insight: string | null,
    _onSaved?: (_session: PracticeSessionResponse) => void,
  ) => Promise<void>;
  finishAndReset: () => void;
}

export function ActiveRitualSession(props: ActiveRitualSessionProps): React.JSX.Element {
  const [showConfigurator, setShowConfigurator] = useState(false);
  const session = useActiveSession(props);
  return (
    <View testID="active-ritual-session">
      <SessionCard
        effectiveName={props.effectiveName}
        onConfigure={() => setShowConfigurator(true)}
        onSwitch={props.onSwitchPractice}
        config={props.effectiveConfig}
        state={session.state}
        controls={session.controls}
        tarotCardIndex={session.tarotCardIndex}
        cardPick={session.cardPick}
        saveError={session.saveError}
        onRandomBellMetadata={session.onRandomBellMetadata}
      />
      <RitualConfiguratorSheet
        visible={showConfigurator}
        userPracticeId={props.userPractice.id}
        initialName={props.effectiveName}
        initialConfig={props.effectiveConfig}
        onClose={() => setShowConfigurator(false)}
        onSaved={(next) => {
          props.onUserPracticeUpdated(next);
          setShowConfigurator(false);
        }}
      />
      <SessionInsightModal session={session} onWriteReflection={props.onWriteReflection} />
    </View>
  );
}

interface SessionInsightModalProps {
  session: ActiveSession;
  onWriteReflection: ActiveRitualSessionProps['onWriteReflection'];
}

const SessionInsightModal = ({
  session,
  onWriteReflection,
}: SessionInsightModalProps): React.JSX.Element | null => {
  if (!session.completedWindow) return null;
  const durationMinutes =
    (session.completedWindow.end.getTime() - session.completedWindow.start.getTime()) /
    MS_PER_MINUTE;
  // Type-narrow `mode` against `modeMetadata` for the modal's generic.
  return (
    <InsightCaptureModal
      visible
      mode={session.summaryMetadata.mode as ModeSummaryKind}
      durationMinutes={durationMinutes}
      modeMetadata={session.summaryMetadata}
      onSave={(insight) => {
        void session.submitSession(stringOrNull(insight));
      }}
      onSkip={() => {
        void session.submitSession(null);
      }}
      onJournal={(insight) => {
        const captured = stringOrNull(insight);
        void session.submitSession(captured, (saved) =>
          onWriteReflection({ session: saved, insight: captured }),
        );
      }}
    />
  );
};

function stringOrNull(insight: string): string | null {
  const trimmed = insight.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface HarvestedMetadata {
  wireMetadata: SessionMetadata;
  summaryMetadata: ModeSummaryMetadata;
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
}

/** Harvest wire+summary metadata; `random_interval_bell` view lifts its schedule via the setter. */
function useHarvestedMetadata(
  config: ModeConfig,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
): HarvestedMetadata {
  const [randomBellMetadata, setRandomBellMetadata] = useState<RandomIntervalBellMetadata | null>(
    null,
  );
  const wireMetadata = useMemo<SessionMetadata>(
    () => harvestMetadata(config, state, cardPick, randomBellMetadata),
    [config, state, cardPick, randomBellMetadata],
  );
  const summaryMetadata = useMemo<ModeSummaryMetadata>(
    () => harvestSummaryMetadata(config, state, tarotCardIndex, cardPick, randomBellMetadata),
    [config, state, tarotCardIndex, cardPick, randomBellMetadata],
  );
  return { wireMetadata, summaryMetadata, onRandomBellMetadata: setRandomBellMetadata };
}

function useActiveSession(props: ActiveRitualSessionProps): ActiveSession {
  const tarotCardIndex = useTarotCardIndex(props);
  const engineDeps = useMemo(() => ({ startCardIndex: tarotCardIndex }), [tarotCardIndex]);
  const [state, controls] = useRitualEngine(props.effectiveConfig, engineDeps);
  useKeepAwakeWhileRunning(state.status);
  const window = useCompletionWindow(state.status);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cardPick = useCardPick(props.effectiveConfig);
  const { wireMetadata, summaryMetadata, onRandomBellMetadata } = useHarvestedMetadata(
    props.effectiveConfig,
    state,
    tarotCardIndex,
    cardPick,
  );
  const saveMutation = useSaveMutation({
    apply: props.onSessionApply,
    rollback: props.onSessionRollback,
    commit: props.onSessionCommitted,
    setSaveError,
  });
  const finishAndReset = useCallback(() => {
    window.reset();
    setSaveError(null);
    controls.cancel();
  }, [window, controls]);
  const submitSession = useSubmitSession({
    userPracticeId: props.userPractice.id,
    completedWindow: window.completedWindow,
    metadata: wireMetadata,
    saveMutation,
    finishAndReset,
  });
  return {
    state,
    controls,
    wireMetadata,
    summaryMetadata,
    tarotCardIndex,
    cardPick,
    completedWindow: window.completedWindow,
    isSaving: saveMutation.pending,
    saveError,
    onRandomBellMetadata,
    submitSession,
    finishAndReset,
  };
}

/**
 * Draw the `card_meditation` card once per session. Resolving it here (not
 * separately in the view and the metadata harvest) guarantees the displayed
 * card and the recorded card are always the same draw.
 */
function useCardPick(config: ModeConfig): PickedCard | null {
  return useMemo(() => (config.mode === 'card_meditation' ? pickCard(config) : null), [config]);
}

function useTarotCardIndex(props: ActiveRitualSessionProps): number {
  return useMemo(
    () =>
      props.effectiveConfig.mode === 'tarot'
        ? daysSinceStart(props.userPractice.start_date, props.userTimezone)
        : 0,
    [props.effectiveConfig.mode, props.userPractice.start_date, props.userTimezone],
  );
}

function useKeepAwakeWhileRunning(status: RitualState['status']): void {
  // Pair `activateKeepAwakeAsync` with `deactivateKeepAwake` so the device
  // is only kept awake while the engine is actively running. A bare
  // unconditional `useKeepAwake()` would hold the wake-lock for the entire
  // active session — including the idle window before tap-Start and the
  // post-complete insight modal — which would drain the battery for users
  // who walk away from the screen after setting up a practice.
  useEffect(() => {
    if (status !== 'running') return undefined;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      // `deactivateKeepAwake` returns a Promise on native but a useEffect
      // cleanup must return `void`; fire-and-forget is correct here — the
      // OS settles the wake-lock at its own pace.
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [status]);
}

interface CompletionWindow {
  completedWindow: { start: Date; end: Date } | null;
  reset: () => void;
}

function useCompletionWindow(status: RitualState['status']): CompletionWindow {
  const [completedWindow, setCompletedWindow] = useState<{ start: Date; end: Date } | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev !== 'running' && status === 'running') {
      startedAtRef.current = new Date();
    }
    if (prev !== 'complete' && status === 'complete') {
      const started = startedAtRef.current ?? new Date();
      setCompletedWindow({ start: started, end: new Date() });
    }
    if (status === 'idle' && prev !== 'idle') {
      setCompletedWindow(null);
      startedAtRef.current = null;
    }
    prevStatusRef.current = status;
  }, [status]);
  const reset = useCallback(() => {
    setCompletedWindow(null);
    startedAtRef.current = null;
  }, []);
  return { completedWindow, reset };
}

interface SubmitSessionParams {
  userPracticeId: number;
  completedWindow: { start: Date; end: Date } | null;
  metadata: SessionMetadata;
  saveMutation: { mutate: (_input: PracticeSessionCreate) => Promise<PracticeSessionResponse> };
  finishAndReset: () => void;
}

function useSubmitSession({
  completedWindow,
  userPracticeId,
  metadata,
  saveMutation,
  finishAndReset,
}: SubmitSessionParams): (
  _insight: string | null,
  _onSaved?: (_session: PracticeSessionResponse) => void,
) => Promise<void> {
  // Flatten the dependencies so `useCallback` actually memoises — passing
  // the parent's `params` object as a single dep would invalidate every
  // render (new object literal each time), making the memo a no-op.
  return useCallback(
    async (insight, onSaved) => {
      if (!completedWindow) return;
      const payload: PracticeSessionCreate = {
        user_practice_id: userPracticeId,
        started_at: completedWindow.start.toISOString(),
        ended_at: completedWindow.end.toISOString(),
        mode_metadata: metadata,
        completed: true,
        insight,
      };
      try {
        const session = await saveMutation.mutate(payload);
        onSaved?.(session);
        finishAndReset();
      } catch {
        // Rollback closure surfaced the error via setSaveError.
      }
    },
    [completedWindow, userPracticeId, metadata, saveMutation, finishAndReset],
  );
}

interface SessionCardProps {
  effectiveName: string;
  onConfigure: () => void;
  onSwitch: () => void;
  config: ModeConfig;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
  saveError: string | null;
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
}

function SessionCard(props: SessionCardProps): React.JSX.Element {
  return (
    <View style={styles.card} testID="active-practice-card">
      <View style={styles.cardHeader}>
        <Text style={styles.label}>Your Practice</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Configure practice"
          onPress={props.onConfigure}
          style={styles.gearButton}
          testID="active-practice-configure"
        >
          <Text style={styles.gearText}>⚙︎</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.name} testID="active-practice-name">
        {props.effectiveName}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Replace this practice"
        onPress={props.onSwitch}
        style={styles.switchLink}
        testID="active-practice-switch"
      >
        <Text style={styles.switchText}>Tap the banner above to replace</Text>
      </TouchableOpacity>
      <ModeView
        config={props.config}
        state={props.state}
        controls={props.controls}
        tarotCardIndex={props.tarotCardIndex}
        cardPick={props.cardPick}
        onRandomBellMetadata={props.onRandomBellMetadata}
      />
      {props.saveError !== null && (
        <Text style={styles.error} testID="active-practice-save-error">
          {props.saveError}
        </Text>
      )}
    </View>
  );
}

interface ModeViewProps {
  config: ModeConfig;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
}

function ModeView(props: ModeViewProps): React.JSX.Element {
  const { config, state, controls } = props;
  // `random_interval_bell` is dispatched separately: its view takes the metadata callback.
  if (config.mode === 'random_interval_bell') {
    return (
      <RandomIntervalBellView
        config={config}
        state={state}
        controls={controls}
        onMetadataChange={props.onRandomBellMetadata}
      />
    );
  }
  return (
    <EngineModeView
      config={config}
      state={state}
      controls={controls}
      tarotCardIndex={props.tarotCardIndex}
      cardPick={props.cardPick}
    />
  );
}

interface EngineModeViewProps {
  config: Exclude<ModeConfig, { mode: 'random_interval_bell' }>;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
}

function EngineModeView({
  config,
  state,
  controls,
  tarotCardIndex,
  cardPick,
}: EngineModeViewProps): React.JSX.Element {
  switch (config.mode) {
    case 'meditation_timer':
      return <MeditationTimerView state={state} controls={controls} />;
    case 'count_up':
      return <CountUpTimerView state={state} controls={controls} />;
    case 'metronome':
      return <MetronomeView config={config} state={state} controls={controls} />;
    case 'interval_bell':
      return <IntervalBellView config={config} state={state} controls={controls} />;
    case 'rep_counter':
      return <RepCounterView config={config} state={state} controls={controls} />;
    case 'sense_grounding':
      return <SenseGroundingView config={config} state={state} controls={controls} />;
    case 'tallied_grounding':
      return <TalliedGroundingView config={config} state={state} controls={controls} />;
    case 'tarot':
    case 'card_meditation':
      return (
        <CardModeView
          config={config}
          state={state}
          controls={controls}
          tarotCardIndex={tarotCardIndex}
          cardPick={cardPick}
        />
      );
  }
}

interface CardModeViewProps {
  config: TarotConfig | CardMeditationConfig;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
}

/** Renders the two card-based modes; split out to keep `ModeView` simple. */
function CardModeView({
  config,
  state,
  controls,
  tarotCardIndex,
  cardPick,
}: CardModeViewProps): React.JSX.Element {
  if (config.mode === 'tarot') {
    return (
      <TarotMeditationView
        state={state}
        controls={controls}
        card={cardForDayIndex(tarotCardIndex)}
        hideTimer={config.hide_timer_during_meditation ?? false}
      />
    );
  }
  return <CardMeditationView config={config} state={state} controls={controls} picked={cardPick} />;
}

interface UseSaveMutationParams {
  apply: () => void;
  rollback: () => void;
  commit: () => void;
  setSaveError: (_msg: string | null) => void;
}

function useSaveMutation({ apply, rollback, commit, setSaveError }: UseSaveMutationParams) {
  return useOptimisticMutation<PracticeSessionCreate, PracticeSessionResponse>({
    apply: () => {
      setSaveError(null);
      apply();
    },
    commit: async (payload) => {
      const session = await practiceSessions.create(payload);
      commit();
      return session;
    },
    rollback: (_input, err) => {
      rollback();
      setSaveError(formatApiError(err, { fallback: SAVE_FALLBACK }));
    },
  });
}

/**
 * Calendar days between `startDateKey` (YYYY-MM-DD in the user's local TZ,
 * stored by the backend at signup) and today in the same TZ. The result
 * indexes into the major-arcana cycle (mod 22) so each new local-midnight
 * advances the card. Negative values are clamped to 0 so a future
 * `start_date` (clock skew) shows the Fool rather than wrapping backwards.
 */
function daysSinceStart(startDateKey: string, tz: string): number {
  const today = todayDayKey(tz);
  const todayMs = parseDayKeyMs(today);
  const startMs = parseDayKeyMs(startDateKey);
  if (todayMs === null || startMs === null) return 0;
  const diff = Math.floor((todayMs - startMs) / MS_PER_DAY);
  return Math.max(0, diff);
}

function todayDayKey(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  }
}

function parseDayKeyMs(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/**
 * Wire-format metadata stripped of presentation-only extras (e.g.
 * `unit_label`, `card_name` from `ModeSummaryMetadata`). The backend
 * validates this discriminator against the resolved practice mode and
 * returns 400 ``mode_metadata_mismatch`` otherwise.
 *
 * Exported for unit testing the per-mode harvest branches.
 */
export function harvestMetadata(
  config: ModeConfig,
  state: RitualState,
  cardPick: PickedCard | null,
  randomBellMetadata: RandomIntervalBellMetadata | null = null,
): SessionMetadata {
  // `random_interval_bell` schedule is view-owned, so harvest from the lifted metadata.
  if (config.mode === 'random_interval_bell') {
    return (
      randomBellMetadata ?? { mode: 'random_interval_bell', bells_struck: 0, interval_seconds: [] }
    );
  }
  return harvestEngineMetadata(config, state, cardPick);
}

function harvestEngineMetadata(
  config: Exclude<ModeConfig, { mode: 'random_interval_bell' }>,
  state: RitualState,
  cardPick: PickedCard | null,
): SessionMetadata {
  switch (config.mode) {
    case 'meditation_timer':
      return { mode: 'meditation_timer' };
    case 'count_up':
      return { mode: 'count_up' };
    case 'metronome':
      return { mode: 'metronome', bpm_used: config.bpm };
    case 'interval_bell':
      return harvestIntervalBell(config, state);
    case 'rep_counter':
      return { mode: 'rep_counter', rep_count: state.repCount };
    case 'sense_grounding':
      return harvestSenseGrounding(config, state);
    case 'tallied_grounding':
      return harvestTalliedGrounding(config, state);
    case 'tarot':
      return {
        mode: 'tarot',
        card_index: normalizeTarotIndex(state.currentStepIndex),
      };
    case 'card_meditation':
      return cardMeditationWireMetadata(config, cardPick);
  }
}

/**
 * Wire metadata for a `card_meditation` session. `cardPick` is resolved
 * once in `useActiveSession`; the fallback only guards a direct call
 * without a pre-resolved draw.
 */
function cardMeditationWireMetadata(
  config: CardMeditationConfig,
  cardPick: PickedCard | null,
): SessionMetadata {
  return buildCardMeditationMetadata(config, cardPick ?? pickCard(config));
}

/**
 * Tallied-grounding wire metadata. `items_completed` is the linear tap
 * count clamped to the ritual total; `rounds_completed` is how many full
 * rounds those taps covered. The summary metadata reuses this shape
 * verbatim — there are no presentation-only extras.
 */
function harvestTalliedGrounding(
  config: TalliedGroundingConfig,
  state: RitualState,
): Extract<SessionMetadata, { mode: 'tallied_grounding' }> {
  const perRound = totalStepsPerRound(config);
  const itemsCompleted = Math.min(state.currentStepIndex, totalSteps(config));
  return {
    mode: 'tallied_grounding',
    rounds_completed: perRound > 0 ? Math.floor(itemsCompleted / perRound) : 0,
    total_rounds: config.rounds,
    items_completed: itemsCompleted,
  };
}

function harvestIntervalBell(config: IntervalBellConfig, state: RitualState): SessionMetadata {
  const intervalCues = scheduledCues(config).filter((c) => c.kind === 'interval_bell');
  const struck = intervalCues.filter((c) => c.atMs <= state.elapsedMs).length;
  return {
    mode: 'interval_bell',
    intervals_struck: struck,
    total_intervals: intervalCues.length,
  };
}

function harvestSenseGrounding(config: SenseGroundingConfig, state: RitualState): SessionMetadata {
  const completed = config.prompts
    .slice(0, Math.min(state.currentStepIndex, config.prompts.length))
    .map((p) => p.sense);
  return { mode: 'sense_grounding', senses_completed: completed };
}

function normalizeTarotIndex(index: number): number {
  return ((index % TAROT_DECK_SIZE) + TAROT_DECK_SIZE) % TAROT_DECK_SIZE;
}

/**
 * Presentation-layer metadata for the ritual-12 `InsightCaptureModal`
 * summary. Carries the same fields as the wire `SessionMetadata` plus
 * presentation-only extras (`unit_label`, `card_name`) the formatter needs.
 *
 * Exported for unit testing the per-mode harvest branches.
 */
export function harvestSummaryMetadata(
  config: ModeConfig,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
  randomBellMetadata: RandomIntervalBellMetadata | null = null,
): ModeSummaryMetadata {
  if (config.mode === 'random_interval_bell') {
    return { mode: 'random_interval_bell', bells_struck: randomBellMetadata?.bells_struck ?? 0 };
  }
  return harvestEngineSummary(config, state, tarotCardIndex, cardPick);
}

function harvestEngineSummary(
  config: Exclude<ModeConfig, { mode: 'random_interval_bell' }>,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
): ModeSummaryMetadata {
  switch (config.mode) {
    case 'meditation_timer':
      return { mode: 'meditation_timer' };
    case 'count_up':
      return { mode: 'count_up' };
    case 'metronome':
      return { mode: 'metronome', bpm_used: config.bpm };
    case 'interval_bell': {
      const wire = harvestIntervalBell(config, state) as Extract<
        SessionMetadata,
        { mode: 'interval_bell' }
      >;
      return {
        mode: 'interval_bell',
        intervals_struck: wire.intervals_struck,
        total_intervals: wire.total_intervals,
      };
    }
    case 'rep_counter':
      return repCounterSummary(config, state);
    case 'sense_grounding': {
      const wire = harvestSenseGrounding(config, state) as Extract<
        SessionMetadata,
        { mode: 'sense_grounding' }
      >;
      return { mode: 'sense_grounding', senses_completed: wire.senses_completed };
    }
    case 'tallied_grounding':
      // Wire and summary shapes are identical — no presentation-only extras.
      return harvestTalliedGrounding(config, state);
    case 'tarot': {
      const idx = normalizeTarotIndex(tarotCardIndex);
      return { mode: 'tarot', card_index: idx, card_name: cardForDayIndex(idx).name };
    }
    case 'card_meditation': {
      // Reuse the wire harvest (and its single card draw) rather than drawing
      // the card a second time — mirrors the `interval_bell` reuse above.
      const wire = harvestMetadata(config, state, cardPick) as Extract<
        SessionMetadata,
        { mode: 'card_meditation' }
      >;
      return { mode: 'card_meditation', deck_id: wire.deck_id, card_name: wire.card_drawn_name };
    }
  }
}

function repCounterSummary(config: RepCounterConfig, state: RitualState): ModeSummaryMetadata {
  return {
    mode: 'rep_counter',
    rep_count: state.repCount,
    unit_label: config.unit_label,
  };
}

const styles = StyleSheet.create({
  card: {
    margin: SPACING.lg,
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    ...shadows.medium,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  label: {
    fontSize: 13,
    color: colors.text.tertiary,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  gearButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearText: { fontSize: 22, color: colors.text.secondary },
  name: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.xs,
  },
  switchLink: { alignSelf: 'flex-start', paddingVertical: SPACING.xs, marginBottom: SPACING.md },
  switchText: { fontSize: 12, color: colors.text.tertiary, fontStyle: 'italic' },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
});

export default ActiveRitualSession;
