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
 *   - Mount `useRitualEngine(effectiveConfig)` for the active session. A
 *     same-row configurator save does not remount (the `key` is stable);
 *     instead the engine reconciles an idle countdown in-place via its
 *     `CONFIG_CHANGED` path, and a running/paused session is left intact.
 *   - Dispatch on `effectiveConfig.mode` to the correct mode view.
 *   - Harvest per-mode `SessionMetadata` (wire) and `ModeSummaryMetadata`
 *     (display) from engine state on completion.
 *   - Open the ritual-12 `InsightCaptureModal` on the `idle → … → complete`
 *     transition; never on cancel.
 *   - Drive the optimistic week-count increment via the parent-supplied
 *     `useWeeklyProgress` callbacks so the bar reconciles with server truth.
 *   - Activate keep-awake while the engine is `running` (not for the whole
 *     active-card lifetime).
 *   - Inject the expo-haptics and expo-audio adapters so ritual cues emit
 *     tactile feedback and audible bells.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type {
  PracticeSessionCreate,
  PracticeSessionResponse,
  SessionMetadata,
  UserPractice,
} from '@/api';
import { practiceSessions } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { SPACING, colors } from '@/design/tokens';
import { InsightCaptureModal } from '@/features/Practice/components/InsightCaptureModal';
import RitualConfiguratorSheet from '@/features/Practice/configurator/RitualConfiguratorSheet';
import type { PickedCard } from '@/features/Practice/data/resolveCard';
import { pickCard } from '@/features/Practice/data/resolveCard';
import { cardForDayIndex } from '@/features/Practice/data/tarot';
import { createExpoAudioAdapter } from '@/features/Practice/engine/adapters/audio';
import { createExpoHapticsAdapter } from '@/features/Practice/engine/adapters/haptics';
import {
  daysSinceStart,
  harvestMetadata,
  harvestSummaryMetadata,
} from '@/features/Practice/engine/harvestMetadata';
import type {
  AudioAdapter,
  CardMeditationConfig,
  EngineDeps,
  MindfulAnchorMetadata,
  ModeConfig,
  RandomIntervalBellMetadata,
  RitualControls,
  RitualState,
  TarotConfig,
} from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';
import { useRitualEngine } from '@/features/Practice/engine/useRitualEngine';
import type { ModeSummaryKind, ModeSummaryMetadata } from '@/features/Practice/insights/format';
import CardMeditationView from '@/features/Practice/views/CardMeditationView';
import CountUpTimerView from '@/features/Practice/views/CountUpTimerView';
import IntervalBellView from '@/features/Practice/views/IntervalBellView';
import MeditationTimerView from '@/features/Practice/views/MeditationTimerView';
import MetronomeView from '@/features/Practice/views/MetronomeView';
import MindfulAnchorView from '@/features/Practice/views/MindfulAnchorView';
import RandomIntervalBellView from '@/features/Practice/views/RandomIntervalBellView';
import RepCounterView from '@/features/Practice/views/RepCounterView';
import SenseGroundingView from '@/features/Practice/views/SenseGroundingView';
import { SessionSurfaceProvider, UMBER_SURFACE } from '@/features/Practice/views/sessionSurface';
import TalliedGroundingView from '@/features/Practice/views/TalliedGroundingView';
import TarotMeditationView from '@/features/Practice/views/TarotMeditationView';
import { useOptimisticMutation } from '@/hooks/useOptimisticMutation';

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
  /** Observe engine status transitions (e.g. to collapse the identity header mid-session). */
  onStatusChange?: (_status: RitualState['status']) => void;
  /** Injectable audio adapter for tests; defaults to the bundled bell audio. */
  audio?: AudioAdapter;
}

interface ActiveSession {
  state: RitualState;
  controls: RitualControls;
  summaryMetadata: ModeSummaryMetadata;
  tarotCardIndex: number;
  /** The card drawn for a `card_meditation` session; `null` for other modes. */
  cardPick: PickedCard | null;
  /** `mindful_anchor` view hands its save payload up through this. */
  onMindfulAnchorComplete: (_metadata: MindfulAnchorMetadata) => void;
  completedWindow: { start: Date; end: Date } | null;
  saveError: string | null;
  /** Lifts the random-bell view's live schedule metadata for the harvest. */
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
  submitSession: (
    _insight: string | null,
    _onSaved?: (_session: PracticeSessionResponse) => void,
  ) => Promise<void>;
}

/** Imperative surface: lets a parent open the configurator sheet (e.g. from a header drawer). */
export interface ActiveRitualSessionHandle {
  openConfigurator: () => void;
}

export const ActiveRitualSession = forwardRef<ActiveRitualSessionHandle, ActiveRitualSessionProps>(
  function ActiveRitualSession(props, ref): React.JSX.Element {
    const [showConfigurator, setShowConfigurator] = useState(false);
    const session = useActiveSession(props);
    useStatusNotifier(session.state.status, props.onStatusChange);
    useImperativeHandle(ref, () => ({ openConfigurator: () => setShowConfigurator(true) }), []);
    return (
      <View testID="active-ritual-session">
        <SessionCard
          config={props.effectiveConfig}
          state={session.state}
          controls={session.controls}
          tarotCardIndex={session.tarotCardIndex}
          cardPick={session.cardPick}
          onMindfulAnchorComplete={session.onMindfulAnchorComplete}
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
  },
);

/**
 * Report engine status transitions upward (the parent collapses the identity
 * header while a session runs). Pure observation — no engine-logic change.
 */
function useStatusNotifier(
  status: RitualState['status'],
  onStatusChange?: (_status: RitualState['status']) => void,
): void {
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);
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
  onMindfulAnchorComplete: (metadata: MindfulAnchorMetadata) => void;
  /** Clears the lifted mindful-anchor payload after a save completes. */
  resetMindfulAnchor: () => void;
}

/**
 * Harvest wire+summary metadata. The `random_interval_bell` view lifts its
 * live schedule via the setter; the `mindful_anchor` view lifts its full
 * save payload (chosen option + duration + soft-floor flag) the same way.
 */
function useHarvestedMetadata(
  config: ModeConfig,
  state: RitualState,
  tarotCardIndex: number,
  cardPick: PickedCard | null,
): HarvestedMetadata {
  const [randomBellMetadata, setRandomBellMetadata] = useState<RandomIntervalBellMetadata | null>(
    null,
  );
  const [mindfulAnchorMeta, setMindfulAnchorMeta] = useState<MindfulAnchorMetadata | null>(null);
  const wireMetadata = useMemo<SessionMetadata>(
    () => harvestMetadata(config, state, cardPick, randomBellMetadata, mindfulAnchorMeta),
    [config, state, cardPick, randomBellMetadata, mindfulAnchorMeta],
  );
  const summaryMetadata = useMemo<ModeSummaryMetadata>(
    () => harvestSummaryMetadata(config, state, tarotCardIndex, cardPick, randomBellMetadata),
    [config, state, tarotCardIndex, cardPick, randomBellMetadata],
  );
  const resetMindfulAnchor = useCallback(() => setMindfulAnchorMeta(null), []);
  return {
    wireMetadata,
    summaryMetadata,
    onRandomBellMetadata: setRandomBellMetadata,
    onMindfulAnchorComplete: setMindfulAnchorMeta,
    resetMindfulAnchor,
  };
}

function useEngineDeps(tarotCardIndex: number, injectedAudio?: AudioAdapter): EngineDeps {
  const [haptics] = useState(() => createExpoHapticsAdapter());
  const [audio] = useState<AudioAdapter>(() => injectedAudio ?? createExpoAudioAdapter());
  useEffect(() => () => audio.dispose?.(), [audio]);
  return useMemo(
    () => ({ startCardIndex: tarotCardIndex, haptics, audio }),
    [tarotCardIndex, haptics, audio],
  );
}

function useActiveSession(props: ActiveRitualSessionProps): ActiveSession {
  const tarotCardIndex = useTarotCardIndex(props);
  const engineDeps = useEngineDeps(tarotCardIndex, props.audio);
  const [state, controls] = useRitualEngine(props.effectiveConfig, engineDeps);
  useKeepAwakeWhileRunning(state.status);
  const window = useCompletionWindow(state.status);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cardPick = useCardPick(props.effectiveConfig);
  const {
    wireMetadata,
    summaryMetadata,
    onRandomBellMetadata,
    onMindfulAnchorComplete,
    resetMindfulAnchor,
  } = useHarvestedMetadata(props.effectiveConfig, state, tarotCardIndex, cardPick);
  const saveMutation = useSaveMutation({
    apply: props.onSessionApply,
    rollback: props.onSessionRollback,
    commit: props.onSessionCommitted,
    setSaveError,
  });
  const finishAndReset = useCallback(() => {
    window.reset();
    setSaveError(null);
    resetMindfulAnchor();
    controls.cancel();
  }, [window, controls, resetMindfulAnchor]);
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
    summaryMetadata,
    tarotCardIndex,
    cardPick,
    onMindfulAnchorComplete,
    completedWindow: window.completedWindow,
    saveError,
    onRandomBellMetadata,
    submitSession,
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
  config: ModeConfig;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
  onMindfulAnchorComplete: (_metadata: MindfulAnchorMetadata) => void;
  saveError: string | null;
  onRandomBellMetadata: (metadata: RandomIntervalBellMetadata) => void;
}

function SessionCard(props: SessionCardProps): React.JSX.Element {
  // The session rests flat on the full-bleed umber player ground: identity
  // chrome (name, stage chip, customize pencil) lives in the parent's
  // PracticeIdentityHeader, so the card is just the mode view plus any save
  // error. The shared RitualControlsBar plays the completion Celebration.
  return (
    <View style={styles.card} testID="active-practice-card">
      <SessionSurfaceProvider value={UMBER_SURFACE}>
        <ModeView
          config={props.config}
          state={props.state}
          controls={props.controls}
          tarotCardIndex={props.tarotCardIndex}
          cardPick={props.cardPick}
          onRandomBellMetadata={props.onRandomBellMetadata}
          onMindfulAnchorComplete={props.onMindfulAnchorComplete}
        />
      </SessionSurfaceProvider>
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
  onMindfulAnchorComplete: (_metadata: MindfulAnchorMetadata) => void;
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
      onMindfulAnchorComplete={props.onMindfulAnchorComplete}
    />
  );
}

interface EngineModeViewProps {
  config: Exclude<ModeConfig, { mode: 'random_interval_bell' }>;
  state: RitualState;
  controls: RitualControls;
  tarotCardIndex: number;
  cardPick: PickedCard | null;
  onMindfulAnchorComplete: (_metadata: MindfulAnchorMetadata) => void;
}

function EngineModeView({
  config,
  state,
  controls,
  tarotCardIndex,
  cardPick,
  onMindfulAnchorComplete,
}: EngineModeViewProps): React.JSX.Element {
  if (config.mode === 'tarot' || config.mode === 'card_meditation') {
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
  if (config.mode === 'mindful_anchor') {
    return (
      <MindfulAnchorView
        config={config}
        state={state}
        controls={controls}
        onComplete={onMindfulAnchorComplete}
      />
    );
  }
  return <BasicEngineModeView config={config} state={state} controls={controls} />;
}

type BasicEngineModeConfig = Exclude<
  EngineModeViewProps['config'],
  { mode: 'tarot' | 'card_meditation' | 'mindful_anchor' }
>;

interface BasicEngineModeViewProps {
  config: BasicEngineModeConfig;
  state: RitualState;
  controls: RitualControls;
}

/** Plain dispatch for the engine modes that take only `(config, state, controls)`. */
function BasicEngineModeView({
  config,
  state,
  controls,
}: BasicEngineModeViewProps): React.JSX.Element {
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

const styles = StyleSheet.create({
  // Flat session container resting directly on the umber player ground.
  card: {
    paddingBottom: SPACING.lg,
    marginBottom: SPACING.lg,
  },
  error: {
    // The light destructive border swatch doubles as an AA-clearing (~6.3:1)
    // danger ink on the umber ground; the dark `colors.danger` fill does not.
    color: colors.destructive.border,
    fontSize: 14,
    marginTop: SPACING.md,
    textAlign: 'center',
  },
});

export default ActiveRitualSession;
