/**
 * ``PracticeDetailScreen`` — read-only summary of a single practice with
 * the actions a user can take from the catalog.
 *
 * Reachable from the pushed catalog (preset / draft / imported rows), from the
 * Practice drawer, and from the wizard after a successful create. The Practice
 * tab's embedded catalog shows the same view in place instead
 * (``PracticeDetailSheet``, #2451), which is why the body is exported as a
 * navigator-free controller + content pair. The summary intentionally renders the
 * mode + config as plain bullet points; deep customization stays in the
 * configurator sheet (per-user override) and the wizard (full copy).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { CARD_MEDITATION_CUSTOM_DECK_ID, type ModeConfig } from '../engine/types';

import { type PracticeItem, practices, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  BORDER_RADIUS,
  INTERACTIVE_TEXT_MIN,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  surface,
  surfaceShadow,
} from '@/design/tokens';
import CopyToStageDialog from '@/features/Practice/components/CopyToStageDialog';
import { LoadErrorRetry, LoadingBlock } from '@/features/Practice/components/LoadErrorRetry';
import {
  MODE_CATEGORIES,
  type PickableMode,
  resolvePickableMode,
} from '@/features/Practice/components/ModePicker';
import PracticeStatsBlock from '@/features/Practice/components/PracticeStatsBlock';
import ShareSheet from '@/features/Practice/components/ShareSheet';
import StageSelector from '@/features/Practice/components/StageSelector';
import { getDeck } from '@/features/Practice/data/decks';
import { usePracticeStats } from '@/features/Practice/hooks/usePracticeStats';
import { copyPracticeToStage } from '@/features/Practice/utils/copyPracticeToStage';
import { formatDuration } from '@/features/Practice/utils/formatDuration';
import type { RootStackParamList } from '@/navigation/RootStack';
import { programStage, useProgramStore } from '@/store/useProgramStore';

export type PracticeDetailScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'PracticeDetail'
>;

interface ScreenState {
  practice: PracticeItem | null;
  loadError: string | null;
  actionError: string | null;
  assigning: boolean;
  loading: boolean;
  pickerOpen: boolean;
  // Target stage while the confirm-and-copy dialog is open; null when closed.
  copyTarget: number | null;
}

function initialState(actionError: string | null): ScreenState {
  return {
    practice: null,
    loadError: null,
    actionError,
    assigning: false,
    loading: true,
    pickerOpen: false,
    copyTarget: null,
  };
}

/**
 * Which "use this practice" path applies: the picker when the current stage is
 * unknown, a direct assign when it matches the practice's home stage, or a
 * confirm-and-copy when it differs.
 */
export function resolveUseAction(
  currentStage: number | null,
  homeStage: number,
): 'picker' | 'assign' | 'copy' {
  if (currentStage === null) return 'picker';
  return currentStage === homeStage ? 'assign' : 'copy';
}

/** Routes the "use for current stage" and picker taps to assign vs copy. */
function useDetailUseHandlers(
  state: PracticeDetailHook,
  practice: PracticeItem,
): { onUseForCurrentStage: () => void; onPickStage: (stage: number) => void } {
  const anchor = useProgramStore((s) => s.programStartDate);
  const currentStage = programStage(anchor);
  const onUseForCurrentStage = (): void => {
    if (currentStage === null) {
      state.openPicker();
      return;
    }
    if (resolveUseAction(currentStage, practice.stage_number) === 'assign') {
      void state.assign(currentStage);
      return;
    }
    state.openCopy(currentStage);
  };
  const onPickStage = (stage: number): void => {
    if (stage === practice.stage_number) {
      void state.assign(stage);
      return;
    }
    // ``openCopy`` also closes the picker, so one dispatch covers both.
    state.openCopy(stage);
  };
  return { onUseForCurrentStage, onPickStage };
}

/** The params "Duplicate & edit" opens the wizard with. */
export type CustomizeCopyParams = NonNullable<RootStackParamList['CreatePractice']>;

/**
 * The wizard prefill for "Duplicate & edit", or ``null`` when the practice has
 * no ``mode_config`` to copy (the action is disabled for those rows anyway).
 */
export function buildCustomizePrefill(practice: PracticeItem): CustomizeCopyParams | null {
  if (practice.mode_config === undefined) return null;
  return {
    prefill: {
      config: practice.mode_config,
      name: practice.name,
      description: practice.description,
      instructions: practice.instructions,
      duration: Math.round(practice.default_duration_minutes),
      stageNumber: practice.stage_number,
    },
  };
}

export interface PracticeDetailControllerOptions {
  practiceId: number;
  /** A failure handed in by the opener, shown in the same banner as this view's own. */
  initialActionError?: string | null;
  /** Runs after an assign or a cross-stage copy succeeds. */
  onAssigned: () => void;
  /** Opens the wizard with a copy of this practice. */
  onCustomizeCopy: (params: CustomizeCopyParams) => void;
}

/** Everything the detail view needs, free of any navigator. */
export interface PracticeDetailController {
  detail: PracticeDetailHook;
  shareOpen: boolean;
  openShare: () => void;
  closeShare: () => void;
  customizeCopy: (practice: PracticeItem) => void;
}

/**
 * The navigation-agnostic heart of the detail view (#2451).
 *
 * The route screen and the Practice tab's in-place overlay both run this; only
 * what happens after an assign and where "Duplicate & edit" goes differ, and
 * those arrive as callbacks rather than as a navigator, so neither host has to
 * pretend to be the other.
 */
export function usePracticeDetailController({
  practiceId,
  initialActionError = null,
  onAssigned,
  onCustomizeCopy,
}: PracticeDetailControllerOptions): PracticeDetailController {
  const detail = usePracticeDetail(practiceId, onAssigned, initialActionError);
  const [shareOpen, setShareOpen] = useState(false);
  const openShare = useCallback(() => setShareOpen(true), []);
  const closeShare = useCallback(() => setShareOpen(false), []);
  const customizeCopy = useCallback(
    (practice: PracticeItem) => {
      const params = buildCustomizePrefill(practice);
      if (params !== null) onCustomizeCopy(params);
    },
    [onCustomizeCopy],
  );
  return { detail, shareOpen, openShare, closeShare, customizeCopy };
}

/**
 * Where the detail view is presented. ``screen`` is the pushed route, whose
 * markup is unchanged; ``sheet`` is the card of the Practice tab's overlay,
 * which keeps loading and errors inside the card so a tap always shows it.
 */
export type PracticeDetailFrame = 'screen' | 'sheet';

interface DetailContentProps {
  controller: PracticeDetailController;
  frame: PracticeDetailFrame;
}

/** The scroller the loaded view sits in for each frame. */
function DetailScroller({
  frame,
  children,
}: {
  frame: PracticeDetailFrame;
  children: React.ReactNode;
}): React.JSX.Element {
  if (frame === 'screen') {
    return (
      <ScreenScaffold scroll style={styles.scaffold} testID="practice-detail-screen">
        {children}
      </ScreenScaffold>
    );
  }
  return (
    <ScrollView
      style={styles.sheetScroll}
      contentContainerStyle={styles.sheetScrollContent}
      testID="practice-detail-sheet-scroll"
    >
      {children}
    </ScrollView>
  );
}

/** The loaded detail view (practice guaranteed non-null). */
function LoadedDetail({
  controller,
  practice,
  frame,
}: DetailContentProps & { practice: PracticeItem }): React.JSX.Element {
  const state = controller.detail;
  const { onUseForCurrentStage, onPickStage } = useDetailUseHandlers(state, practice);
  // Keyed on the catalog id the screen was opened with; the hook resolves the
  // caller's own adoption of it before asking for any totals.
  const { stats } = usePracticeStats(practice.id);

  return (
    <DetailScroller frame={frame}>
      <DetailHeader practice={practice} />
      <DetailBody practice={practice} />
      <PracticeStatsBlock stats={stats} />
      {state.actionError !== null && (
        <Text style={styles.errorText} testID="practice-detail-action-error">
          {state.actionError}
        </Text>
      )}
      <ActionRow
        practice={practice}
        onUseForCurrentStage={onUseForCurrentStage}
        onUseForStage={state.openPicker}
        onCustomizeCopy={() => controller.customizeCopy(practice)}
        onShare={controller.openShare}
      />
      {state.pickerOpen && (
        <StagePicker assigning={state.assigning} onPick={onPickStage} onClose={state.closePicker} />
      )}
    </DetailScroller>
  );
}

/** The detail view's loading, error and loaded states, framed for its host. */
export function PracticeDetailContent({
  controller,
  frame,
}: DetailContentProps): React.JSX.Element {
  const state = controller.detail;
  const sheet = frame === 'sheet';
  if (state.loading) {
    return (
      <LoadingBlock
        style={sheet ? styles.sheetLoading : styles.loading}
        color={accent.primary}
        size="large"
        testID="practice-detail-loading"
      />
    );
  }
  if (state.loadError !== null || state.practice === null) {
    return (
      <LoadErrorRetry
        message={state.loadError ?? 'Could not load practice.'}
        onRetry={state.reload}
        containerStyle={sheet ? styles.sheetErrorBlock : styles.errorBlock}
        containerTestID="practice-detail-error"
        messageStyle={styles.errorText}
        retryStyle={styles.actionButton}
        retryTextStyle={styles.actionButtonText}
        retryTestID="practice-detail-retry"
        retryAccessibilityLabel="Retry"
      />
    );
  }
  return <LoadedDetail controller={controller} practice={state.practice} frame={frame} />;
}

/**
 * The copy dialog and share sheet. Both are Modals of their own, so a host
 * that is itself a Modal mounts these BESIDE it, never inside: iOS presents a
 * nested modal underneath its parent, hiding it.
 */
export function PracticeDetailDialogs({
  controller,
}: {
  controller: PracticeDetailController;
}): React.JSX.Element | null {
  const { practice } = controller.detail;
  if (practice === null) return null;
  return (
    <>
      <DetailCopyDialog state={controller.detail} practice={practice} />
      <ShareSheet
        visible={controller.shareOpen}
        practiceId={practice.id}
        onClose={controller.closeShare}
      />
    </>
  );
}

/** The cross-stage confirm-and-copy dialog for the detail screen. */
function DetailCopyDialog({
  state,
  practice,
}: {
  state: PracticeDetailHook;
  practice: PracticeItem;
}): React.JSX.Element {
  return (
    <CopyToStageDialog
      visible={state.copyTarget !== null}
      practiceName={practice.name}
      homeStage={practice.stage_number}
      targetStage={state.copyTarget ?? practice.stage_number}
      busy={state.assigning}
      onConfirm={(name) => void state.confirmCopy(name)}
      onCancel={state.cancelCopy}
    />
  );
}

/** The pushed route: the shared detail view, returning to the player on assign. */
export function PracticeDetailScreen(props: PracticeDetailScreenProps): React.JSX.Element {
  const { practiceId, assignError } = props.route.params;
  const { navigation } = props;
  // After a successful selection, pop back to the Practice screen (the tab is
  // the first route under the root stack; the catalog + this detail screen are
  // pushed on top), matching the catalog's one-tap "Use" which also returns the
  // user to where they can see the active practice.
  const onAssigned = useCallback(() => navigation.popToTop(), [navigation]);
  const onCustomizeCopy = useCallback(
    (params: CustomizeCopyParams) => navigation.navigate('CreatePractice', params),
    [navigation],
  );
  // A wizard stage-assign that failed hands its message down via the route so
  // the same banner used for this screen's own assign() failures surfaces it.
  const controller = usePracticeDetailController({
    practiceId,
    initialActionError: assignError ?? null,
    onAssigned,
    onCustomizeCopy,
  });
  return (
    <>
      <PracticeDetailContent controller={controller} frame="screen" />
      <PracticeDetailDialogs controller={controller} />
    </>
  );
}

export interface PracticeDetailHook {
  practice: PracticeItem | null;
  loadError: string | null;
  actionError: string | null;
  assigning: boolean;
  loading: boolean;
  pickerOpen: boolean;
  copyTarget: number | null;
  reload: () => void;
  openPicker: () => void;
  closePicker: () => void;
  assign: (stageNumber: number) => Promise<void>;
  openCopy: (targetStage: number) => void;
  cancelCopy: () => void;
  confirmCopy: (name: string) => Promise<void>;
}

const withAssignError = (prev: ScreenState, err: unknown): ScreenState => ({
  ...prev,
  assigning: false,
  actionError: formatApiError(err, { fallback: 'Could not assign practice.' }),
});

/** Confirm-and-copy callbacks for the cross-stage dialog. */
function useCopyFlow(
  state: ScreenState,
  setState: React.Dispatch<React.SetStateAction<ScreenState>>,
  onAssigned?: () => void,
): {
  openCopy: (targetStage: number) => void;
  cancelCopy: () => void;
  confirmCopy: (name: string) => Promise<void>;
} {
  const openCopy = useCallback(
    (targetStage: number) =>
      setState((prev) => ({
        ...prev,
        copyTarget: targetStage,
        pickerOpen: false,
        actionError: null,
      })),
    [setState],
  );
  const cancelCopy = useCallback(
    () => setState((prev) => ({ ...prev, copyTarget: null })),
    [setState],
  );
  const confirmCopy = useCallback(
    async (name: string) => {
      const target = state.copyTarget;
      const source = state.practice;
      if (target === null || source === null) return;
      setState((prev) => ({ ...prev, assigning: true, actionError: null }));
      try {
        await copyPracticeToStage(source, target, name);
        setState((prev) => ({ ...prev, assigning: false, copyTarget: null }));
        onAssigned?.();
      } catch (err) {
        // No rollback: an orphaned draft may remain, so surface the error and stay.
        setState((prev) => ({ ...withAssignError(prev, err), copyTarget: null }));
      }
    },
    [state.copyTarget, state.practice, setState, onAssigned],
  );
  return { openCopy, cancelCopy, confirmCopy };
}

function usePracticeDetail(
  practiceId: number,
  onAssigned?: () => void,
  initialActionError: string | null = null,
): PracticeDetailHook {
  const [state, setState] = useState<ScreenState>(() => initialState(initialActionError));

  const runReload = useCallback(async () => {
    try {
      const practice = await practices.get(practiceId);
      setState((prev) => ({ ...prev, practice, loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        loadError: formatApiError(err, { fallback: 'Could not load practice.' }),
      }));
    }
  }, [practiceId]);

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, loadError: null }));
    void runReload();
  }, [runReload]);

  useEffect(() => {
    reload();
  }, [reload]);

  const openPicker = useCallback(
    () => setState((prev) => ({ ...prev, pickerOpen: true, actionError: null })),
    [],
  );
  const closePicker = useCallback(() => setState((prev) => ({ ...prev, pickerOpen: false })), []);

  const assign = useCallback(
    async (stageNumber: number) => {
      setState((prev) => ({ ...prev, assigning: true, actionError: null }));
      try {
        await userPractices.create({ practice_id: practiceId, stage_number: stageNumber });
        setState((prev) => ({ ...prev, assigning: false, pickerOpen: false }));
        // The callback returns the user to the Practice screen after assigning.
        onAssigned?.();
      } catch (err) {
        setState((prev) => withAssignError(prev, err));
      }
    },
    [practiceId, onAssigned],
  );

  const { openCopy, cancelCopy, confirmCopy } = useCopyFlow(state, setState, onAssigned);

  return { ...state, reload, openPicker, closePicker, assign, openCopy, cancelCopy, confirmCopy };
}

// Derived from MODE_CATEGORIES so a new mode's label propagates here automatically.
const MODE_LABELS: Readonly<Record<PickableMode, string>> = Object.fromEntries(
  MODE_CATEGORIES.flatMap((category) => category.modes.map((entry) => [entry.mode, entry.label])),
) as Record<PickableMode, string>;

/** Label a person reads on a mode (the raw mode is snake_case). */
const FALLBACK_MODE_LABEL = 'Practice';

/**
 * The badge copy for a practice's mode: the picker's human label ("Meditation
 * timer"), or a plain "Practice" when the server knows a mode this client does not.
 */
const modeBadgeLabel = (mode: string | null | undefined): string =>
  MODE_LABELS[resolvePickableMode(mode)] ?? FALLBACK_MODE_LABEL;

interface DetailHeaderProps {
  practice: PracticeItem;
}

const DetailHeader = ({ practice }: DetailHeaderProps): React.JSX.Element => (
  <View style={styles.headerBlock}>
    <Text style={styles.eyebrow}>PRACTICE</Text>
    <Text style={styles.heading} accessibilityRole="header" testID="practice-detail-name">
      {practice.name}
    </Text>
    <View style={styles.metaRow}>
      <BadgeChip label={modeBadgeLabel(practice.mode)} testID="practice-detail-mode-badge" />
      <BadgeChip label={`Stage ${practice.stage_number}`} testID="practice-detail-stage-badge" />
      <BadgeChip
        label={formatDuration(practice.default_duration_minutes)}
        testID="practice-detail-duration-badge"
      />
    </View>
  </View>
);

interface DetailBodyProps {
  practice: PracticeItem;
}

const DetailBody = ({ practice }: DetailBodyProps): React.JSX.Element => (
  <View style={styles.bodyBlock}>
    {practice.description.length > 0 && (
      <BodySection label="Description" testID="practice-detail-description">
        {practice.description}
      </BodySection>
    )}
    {practice.instructions.length > 0 && (
      <BodySection label="Instructions" testID="practice-detail-instructions">
        {practice.instructions}
      </BodySection>
    )}
    {practice.mode_config && <ConfigSummary config={practice.mode_config} />}
  </View>
);

interface BodySectionProps {
  label: string;
  testID: string;
  children: string;
}

const BodySection = ({ label, testID, children }: BodySectionProps): React.JSX.Element => (
  <View style={styles.section}>
    <Text style={styles.sectionLabel}>{label}</Text>
    <Text style={styles.sectionText} testID={testID}>
      {children}
    </Text>
  </View>
);

interface ConfigSummaryProps {
  config: ModeConfig;
}

const ConfigSummary = ({ config }: ConfigSummaryProps): React.JSX.Element => (
  <View style={styles.section} testID="practice-detail-config-summary">
    <Text style={styles.sectionLabel}>Configuration</Text>
    {summarizeConfig(config).map((line, index) => (
      <Text key={index} style={styles.bullet}>
        • {line}
      </Text>
    ))}
  </View>
);

/** Name the deck the way the deck picker does; the inline sentinel is the person's own cards. */
function describeDeck(deckId: string): string {
  if (deckId === CARD_MEDITATION_CUSTOM_DECK_ID) return 'Your own deck';
  const deck = getDeck(deckId);
  return deck === undefined ? 'A deck this app no longer carries' : `Deck: ${deck.name}`;
}

const SUMMARIZERS: {
  [K in ModeConfig['mode']]: (config: Extract<ModeConfig, { mode: K }>) => readonly string[];
} = {
  meditation_timer: (c) => [`Duration: ${c.duration_minutes} min`],
  count_up: (c) => (c.soft_cap_minutes ? [`Soft cap: ${c.soft_cap_minutes} min`] : ['Open-ended']),
  metronome: (c) => [`BPM: ${c.bpm}`, `Duration: ${c.timer.duration_minutes} min`],
  interval_bell: (c) => [
    `Duration: ${c.duration_minutes} min`,
    `Spacing: ${
      c.cue_offsets_minutes
        ? `${c.cue_offsets_minutes.length} custom cues`
        : `every ${c.interval_minutes ?? 5} min`
    }`,
    `Tone: ${c.bell_tone}`,
  ],
  random_interval_bell: (c) => [
    `Duration: ${c.duration_minutes} min`,
    `Interval: ${c.min_interval_seconds}-${c.max_interval_seconds}s`,
    `Tone: ${c.bell_tone}`,
  ],
  rep_counter: (c) => [`Target: ${c.target_reps} ${c.unit_label}`],
  sense_grounding: (c) => [`${c.prompts.length} prompts across the senses`],
  tallied_grounding: (c) => [`${c.rounds} rounds`, `${c.categories.length} categories`],
  tarot: () => ['Major arcana — one card per sit'],
  card_meditation: (c) => [describeDeck(c.deck_id)],
  mindful_anchor: (c) => {
    const anchorWord = c.options.length === 1 ? 'anchor' : 'anchors';
    const choice =
      c.options.length === 0
        ? 'One anchor, no choosing'
        : `${c.options.length} ${anchorWord} to choose from`;
    return [`Aim for at least ${c.min_duration_seconds} seconds`, choice];
  },
};

/**
 * Mode-agnostic config bullets the detail screen renders verbatim.
 *
 * The full per-mode summary helpers live in the runtime views; here we
 * keep the bullets short so the read-only surface stays legible — users
 * who want to tweak a value go through "Customize a copy".
 */
function summarizeConfig(config: ModeConfig): readonly string[] {
  type AnyHint = (c: ModeConfig) => readonly string[];
  const summarize = SUMMARIZERS[config.mode] as AnyHint;
  return summarize(config);
}

interface ActionRowProps {
  practice: PracticeItem;
  onUseForCurrentStage: () => void;
  onUseForStage: () => void;
  onCustomizeCopy: () => void;
  onShare: () => void;
}

const ActionRow = ({
  practice,
  onUseForCurrentStage,
  onUseForStage,
  onCustomizeCopy,
  onShare,
}: ActionRowProps): React.JSX.Element => (
  // ``Edit`` / ``Delete`` are owner-only per the issue spec, but the
  // ``GET /practices/{id}`` response intentionally drops the submitter id
  // (BUG-PRACTICE-001) so the screen cannot tell ownership reliably.
  // "Customize a copy" covers the in-app equivalent until the backend
  // adds an owner hint.
  <View style={styles.actionRow}>
    {/* "Use for current stage" is the common one-tap path; "Use for stage…"
        keeps the explicit 1–10 picker for assigning to a different stage. The
        current stage overlaps one picker option by design. */}
    <ActionButton
      label="Use for current stage"
      onPress={onUseForCurrentStage}
      testID="practice-detail-use-current-stage"
      primary
    />
    <ActionButton
      label="Use for stage…"
      onPress={onUseForStage}
      testID="practice-detail-use-for-stage"
    />
    <ActionButton
      label="Duplicate & edit"
      onPress={onCustomizeCopy}
      testID="practice-detail-customize-copy"
      accessibilityLabel="Duplicate this practice into a new, editable copy"
      disabled={practice.mode_config === undefined}
    />
    <ActionButton
      label="Share"
      onPress={onShare}
      testID="practice-detail-share"
      accessibilityLabel="Share this practice with a link"
    />
  </View>
);

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const ActionButton = ({
  label,
  onPress,
  testID,
  primary = false,
  disabled = false,
  accessibilityLabel,
}: ActionButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }}
    onPress={disabled ? undefined : onPress}
    style={[
      styles.actionButton,
      primary && styles.actionButtonPrimary,
      disabled && styles.disabledButton,
    ]}
    testID={testID}
  >
    <Text style={[styles.actionButtonText, primary && styles.actionButtonTextPrimary]}>
      {label}
    </Text>
  </TouchableOpacity>
);

interface StagePickerProps {
  assigning: boolean;
  onPick: (stageNumber: number) => void;
  onClose: () => void;
}

const StagePicker = ({ assigning, onPick, onClose }: StagePickerProps): React.JSX.Element => (
  <View style={styles.pickerCard} testID="practice-detail-stage-picker">
    <Text style={styles.pickerHeading}>Pick a stage</Text>
    <StageSelector
      variant="picker"
      onSelect={onPick}
      disabled={assigning}
      testIDPrefix="practice-detail-stage-pick"
    />
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Cancel"
      onPress={onClose}
      style={styles.pickerCancel}
      testID="practice-detail-stage-pick-cancel"
    >
      <Text style={styles.pickerCancelText}>Cancel</Text>
    </TouchableOpacity>
  </View>
);

interface BadgeChipProps {
  label: string;
  testID: string;
}

const BadgeChip = ({ label, testID }: BadgeChipProps): React.JSX.Element => (
  <View style={styles.badge} testID={testID}>
    <Text style={styles.badgeText}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: surface.canvas,
  },
  scaffold: { paddingBottom: SPACING.xl },
  // The overlay card's frame: content-sized, shrinking to the card's cap.
  sheetScroll: { flexGrow: 0 },
  sheetScrollContent: { paddingBottom: SPACING.sm },
  sheetLoading: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xl },
  sheetErrorBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.lg,
  },
  headerBlock: { marginBottom: SPACING.md },
  eyebrow: {
    ...editorialType.caption,
    color: accent.primary,
    letterSpacing: 1.5,
    marginBottom: SPACING.xs,
  },
  heading: { ...editorialType.display, color: ink.primary },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  badge: {
    backgroundColor: surface.sunken,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
  },
  badgeText: { color: ink.primary, fontSize: editorialType.caption.fontSize, fontWeight: '600' },
  bodyBlock: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...surfaceShadow.card,
  },
  section: { marginBottom: SPACING.sm },
  sectionLabel: {
    fontSize: editorialType.caption.fontSize,
    fontWeight: '700',
    color: ink.soft,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
  },
  sectionText: { fontSize: 14, color: ink.primary, lineHeight: 20 },
  bullet: { fontSize: 13, color: ink.primary, marginVertical: 1 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  actionButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: surface.hairline,
  },
  actionButtonPrimary: { backgroundColor: accent.primary, borderColor: accent.primary },
  actionButtonText: { color: ink.primary, fontWeight: '600', fontSize: INTERACTIVE_TEXT_MIN },
  actionButtonTextPrimary: { color: accent.onPrimary },
  disabledButton: { opacity: 0.5 },
  pickerCard: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginTop: SPACING.md,
    ...surfaceShadow.card,
  },
  pickerHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: ink.primary,
    marginBottom: SPACING.sm,
  },
  pickerCancel: { marginTop: SPACING.sm, alignSelf: 'flex-end' },
  pickerCancelText: { color: accent.primary, fontWeight: '600', fontSize: INTERACTIVE_TEXT_MIN },
  errorBlock: {
    flex: 1,
    padding: SPACING.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    backgroundColor: surface.canvas,
  },
  errorText: { color: colors.destructive.text, fontSize: 13, marginBottom: SPACING.sm },
});

/** The sheet, exported so the type-ramp test (#2963) can read every size it sets. */
export { styles as practiceDetailStyles };

export default PracticeDetailScreen;
