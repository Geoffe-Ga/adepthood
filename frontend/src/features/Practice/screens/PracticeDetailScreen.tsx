/**
 * ``PracticeDetailScreen`` — read-only summary of a single practice with
 * the actions a user can take from the catalog.
 *
 * Reachable from the catalog (preset / draft / imported rows) and from the
 * wizard after a successful create. The summary intentionally renders the
 * mode + config as plain bullet points; deep customization stays in the
 * configurator sheet (per-user override) and the wizard (full copy).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { ModeConfig } from '../engine/types';

import { type PracticeItem, practices, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import { MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import type { RootStackParamList } from '@/navigation/RootStack';

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
  assignedStage: number | null;
}

function initialState(): ScreenState {
  return {
    practice: null,
    loadError: null,
    actionError: null,
    assigning: false,
    loading: true,
    pickerOpen: false,
    assignedStage: null,
  };
}

/**
 * Top-level screen — fetches a single practice and exposes the action row.
 *
 * "Use for stage" opens a 1-10 stage picker that writes via
 * ``userPractices.create``; "Customize a copy" replays the wizard with
 * this practice's mode_config pre-filled.
 */
export function PracticeDetailScreen(props: PracticeDetailScreenProps): React.JSX.Element {
  const { practiceId } = props.route.params;
  const state = usePracticeDetail(practiceId);
  if (state.loading) {
    return (
      <View style={styles.loading} testID="practice-detail-loading">
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (state.loadError !== null || state.practice === null) {
    return (
      <ErrorView message={state.loadError ?? 'Could not load practice.'} onRetry={state.reload} />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.body} testID="practice-detail-screen">
      <DetailHeader practice={state.practice} />
      <DetailBody practice={state.practice} />
      {state.actionError !== null && (
        <Text style={styles.errorText} testID="practice-detail-action-error">
          {state.actionError}
        </Text>
      )}
      {state.assignedStage !== null && (
        <View style={styles.banner} testID="practice-detail-assigned-banner">
          <Text style={styles.bannerText}>Set as your stage {state.assignedStage} practice.</Text>
        </View>
      )}
      <ActionRow
        practice={state.practice}
        onUseForStage={state.openPicker}
        onCustomizeCopy={() => navigateToCopy(props, state.practice!)}
      />
      {state.pickerOpen && (
        <StagePicker
          assigning={state.assigning}
          onPick={state.assign}
          onClose={state.closePicker}
        />
      )}
    </ScrollView>
  );
}

interface PracticeDetailHook {
  practice: PracticeItem | null;
  loadError: string | null;
  actionError: string | null;
  assigning: boolean;
  loading: boolean;
  pickerOpen: boolean;
  assignedStage: number | null;
  reload: () => void;
  openPicker: () => void;
  closePicker: () => void;
  assign: (stageNumber: number) => Promise<void>;
}

function usePracticeDetail(practiceId: number): PracticeDetailHook {
  const [state, setState] = useState<ScreenState>(initialState);

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
        setState((prev) => ({
          ...prev,
          assigning: false,
          pickerOpen: false,
          assignedStage: stageNumber,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          assigning: false,
          actionError: formatApiError(err, { fallback: 'Could not assign practice.' }),
        }));
      }
    },
    [practiceId],
  );

  return { ...state, reload, openPicker, closePicker, assign };
}

function navigateToCopy(props: PracticeDetailScreenProps, practice: PracticeItem) {
  if (practice.mode_config === undefined) return;
  props.navigation.navigate('CreatePractice', {
    prefill: {
      config: practice.mode_config,
      name: `${practice.name} (copy)`,
      description: practice.description,
      instructions: practice.instructions,
      duration: Math.round(practice.default_duration_minutes),
      stageNumber: practice.stage_number,
    },
  });
}

interface DetailHeaderProps {
  practice: PracticeItem;
}

const DetailHeader = ({ practice }: DetailHeaderProps): React.JSX.Element => (
  <View style={styles.headerBlock}>
    <Text style={styles.heading} testID="practice-detail-name">
      {practice.name}
    </Text>
    <View style={styles.metaRow}>
      <BadgeChip label={practice.mode ?? 'meditation_timer'} testID="practice-detail-mode-badge" />
      <BadgeChip label={`Stage ${practice.stage_number}`} testID="practice-detail-stage-badge" />
      <BadgeChip
        label={`${Math.round(practice.default_duration_minutes)} min`}
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
  card_meditation: (c) => [`Deck: ${c.deck_id}`],
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
  onUseForStage: () => void;
  onCustomizeCopy: () => void;
}

const ActionRow = ({
  practice,
  onUseForStage,
  onCustomizeCopy,
}: ActionRowProps): React.JSX.Element => (
  // ``Edit`` / ``Delete`` are owner-only per the issue spec, but the
  // ``GET /practices/{id}`` response intentionally drops the submitter id
  // (BUG-PRACTICE-001) so the screen cannot tell ownership reliably.
  // "Customize a copy" covers the in-app equivalent until the backend
  // adds an owner hint.
  <View style={styles.actionRow}>
    <ActionButton
      label="Use for stage…"
      onPress={onUseForStage}
      testID="practice-detail-use-for-stage"
      primary
    />
    <ActionButton
      label="Customize a copy"
      onPress={onCustomizeCopy}
      testID="practice-detail-customize-copy"
      disabled={practice.mode_config === undefined}
    />
  </View>
);

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
  disabled?: boolean;
}

const ActionButton = ({
  label,
  onPress,
  testID,
  primary = false,
  disabled = false,
}: ActionButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
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

const StagePicker = ({ assigning, onPick, onClose }: StagePickerProps): React.JSX.Element => {
  const stages = Array.from({ length: MAX_STAGE - MIN_STAGE + 1 }, (_, i) => MIN_STAGE + i);
  return (
    <View style={styles.pickerCard} testID="practice-detail-stage-picker">
      <Text style={styles.pickerHeading}>Pick a stage</Text>
      <View style={styles.pickerRow}>
        {stages.map((n) => (
          <TouchableOpacity
            key={n}
            accessibilityRole="button"
            accessibilityLabel={`Stage ${n}`}
            accessibilityState={{ disabled: assigning }}
            onPress={assigning ? undefined : () => onPick(n)}
            style={[styles.stageBox, assigning && styles.disabledButton]}
            testID={`practice-detail-stage-pick-${n}`}
          >
            <Text style={styles.stageBoxText}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>
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
};

interface BadgeChipProps {
  label: string;
  testID: string;
}

const BadgeChip = ({ label, testID }: BadgeChipProps): React.JSX.Element => (
  <View style={styles.badge} testID={testID}>
    <Text style={styles.badgeText}>{label}</Text>
  </View>
);

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}

const ErrorView = ({ message, onRetry }: ErrorViewProps): React.JSX.Element => (
  <View style={styles.errorBlock} testID="practice-detail-error">
    <Text style={styles.errorText}>{message}</Text>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Retry"
      onPress={onRetry}
      style={styles.actionButton}
      testID="practice-detail-retry"
    >
      <Text style={styles.actionButtonText}>Retry</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl },
  headerBlock: { marginBottom: SPACING.md },
  heading: { fontSize: 22, fontWeight: '700', color: colors.text.primary },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  badge: {
    backgroundColor: colors.background.accent,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
  },
  badgeText: { color: colors.text.primary, fontSize: 12, fontWeight: '600' },
  bodyBlock: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  section: { marginBottom: SPACING.sm },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.secondaryAccessible,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
  },
  sectionText: { fontSize: 14, color: colors.text.primary, lineHeight: 20 },
  bullet: { fontSize: 13, color: colors.text.primary, marginVertical: 1 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  actionButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionButtonText: { color: colors.text.primary, fontWeight: '600', fontSize: 13 },
  actionButtonTextPrimary: { color: colors.text.light },
  disabledButton: { opacity: 0.5 },
  pickerCard: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginTop: SPACING.md,
    ...shadows.small,
  },
  pickerHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
  },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  stageBox: {
    minWidth: 36,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
    alignItems: 'center',
  },
  stageBoxText: { color: colors.text.primary, fontWeight: '700' },
  pickerCancel: { marginTop: SPACING.sm, alignSelf: 'flex-end' },
  pickerCancelText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
  banner: {
    backgroundColor: colors.background.accent,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    marginBottom: SPACING.sm,
  },
  bannerText: { color: colors.successText, fontSize: 13, fontWeight: '600' },
  errorBlock: { padding: SPACING.lg, alignItems: 'center', gap: SPACING.md },
  errorText: { color: colors.destructive.text, fontSize: 13, marginBottom: SPACING.sm },
});

export default PracticeDetailScreen;
