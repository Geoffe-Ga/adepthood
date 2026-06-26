/**
 * ``CreatePracticeWizard`` — guided author flow for a new custom practice.
 *
 * Funnels the user through four lightweight steps so the 11-mode catalog
 * never collapses into a single mega-form (custom-practices-07 UX
 * guard-rail #4):
 *
 *   0. Entry — start from a preset (recommended) or from scratch.
 *   1. Mode picker — categorized cards.
 *   2. Configurator — renders the existing per-mode form.
 *   3. Metadata + assignment — name, description, instructions,
 *      default_duration_minutes, optional stage_number.
 *
 * On submit the wizard POSTs ``/practices/`` and, when the user pinned a
 * stage, follows with ``POST /user-practices/`` so the new draft is
 * already active for that stage. Successful submissions navigate to
 * ``PracticeDetail`` for the brand-new row.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { defaultConfigFor, suggestedDurationFor } from '../configurator/defaults';
import CardMeditationForm from '../configurator/forms/CardMeditationForm';
import CountUpForm from '../configurator/forms/CountUpForm';
import IntervalBellForm from '../configurator/forms/IntervalBellForm';
import MeditationTimerForm from '../configurator/forms/MeditationTimerForm';
import MetronomeForm from '../configurator/forms/MetronomeForm';
import MindfulAnchorForm from '../configurator/forms/MindfulAnchorForm';
import RandomIntervalBellForm from '../configurator/forms/RandomIntervalBellForm';
import RepCounterForm from '../configurator/forms/RepCounterForm';
import SenseGroundingForm from '../configurator/forms/SenseGroundingForm';
import { ErrorList } from '../configurator/forms/shared';
import TalliedGroundingForm from '../configurator/forms/TalliedGroundingForm';
import TarotForm from '../configurator/forms/TarotForm';
import type { ModeConfig } from '../engine/types';
import { validateModeConfig } from '../engine/validation';

import { practices, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';
import ModePicker, { type PickableMode } from '@/features/Practice/components/ModePicker';
import { FALLBACK_STAGE, MAX_STAGE, MIN_STAGE } from '@/features/Practice/constants';
import type { RootStackParamList } from '@/navigation/RootStack';

export type CreatePracticeWizardProps = NativeStackScreenProps<
  RootStackParamList,
  'CreatePractice'
>;

export const PRACTICE_NAME_MAX = 120;
export const PRACTICE_DESCRIPTION_MAX = 1_000;
export const PRACTICE_INSTRUCTIONS_MAX = 2_000;
const PRACTICE_NAME_MIN = 1;

type WizardStep = 'entry' | 'mode' | 'configure' | 'metadata';

interface WizardState {
  step: WizardStep;
  mode: PickableMode | null;
  config: ModeConfig | null;
  name: string;
  description: string;
  instructions: string;
  duration: number;
  stageNumber: number | null;
}

const EMPTY_STATE: WizardState = {
  step: 'entry',
  mode: null,
  config: null,
  name: '',
  description: '',
  instructions: '',
  duration: 0,
  stageNumber: null,
};

function initialState(initial: InitialPrefill | undefined): WizardState {
  if (initial === undefined) return EMPTY_STATE;
  return {
    ...EMPTY_STATE,
    step: 'configure',
    mode: initial.config.mode,
    config: initial.config,
    name: initial.name ?? '',
    description: initial.description ?? '',
    instructions: initial.instructions ?? '',
    duration: initial.duration ?? 0,
    stageNumber: initial.stageNumber ?? null,
  };
}

interface InitialPrefill {
  config: ModeConfig;
  name?: string;
  description?: string;
  instructions?: string;
  duration?: number;
  stageNumber?: number | null;
}

const STEP_TITLES: Record<WizardStep, string> = {
  entry: 'How would you like to start?',
  mode: 'Pick a mode',
  configure: 'Configure',
  metadata: 'Name and save',
};

const STEP_ORDER: readonly WizardStep[] = ['entry', 'mode', 'configure', 'metadata'];

/**
 * Top-level screen — owns wizard state and renders the active step.
 *
 * Routes that opened the wizard from a preset row pass
 * ``route.params.prefill``; the wizard then jumps past the entry step
 * with the chosen mode and config pre-populated.
 */
export function CreatePracticeWizard(props: CreatePracticeWizardProps): React.JSX.Element {
  const [state, setState] = useState<WizardState>(() => initialState(props.route.params?.prefill));
  const submit = useSubmitController(props, state);
  const goTo = (next: WizardStep) => setState((prev) => ({ ...prev, step: next }));
  const setMode = (mode: PickableMode) => setState((prev) => transitionMode(prev, mode));
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.screen}
      testID="create-practice-wizard"
    >
      <StepIndicator step={state.step} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <StepView
          state={state}
          setState={setState}
          goTo={goTo}
          setMode={setMode}
          submit={submit}
          onPickPreset={() => props.navigation.navigate('Tabs', { screen: 'Catalog' })}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function transitionMode(prev: WizardState, mode: PickableMode): WizardState {
  // Every pickable mode has a default config + form, so there is no
  // "unsupported" branch — build the config and advance.
  const config = defaultConfigFor(mode);
  return {
    ...prev,
    mode,
    config,
    duration: prev.duration === 0 ? suggestedDurationFor(config) : prev.duration,
    step: 'configure',
  };
}

interface StepViewProps {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  goTo: (step: WizardStep) => void;
  setMode: (mode: PickableMode) => void;
  submit: SubmitController;
  /** Opens the Practice catalog (preset picker); a chosen preset copies into a fresh wizard via route prefill (issue #472). */
  onPickPreset: () => void;
}

const StepView = (props: StepViewProps): React.JSX.Element => {
  switch (props.state.step) {
    case 'entry':
      return (
        <EntryStep onPickPreset={props.onPickPreset} onStartScratch={() => props.goTo('mode')} />
      );
    case 'mode':
      return (
        <ModeStep
          mode={props.state.mode}
          onSelect={props.setMode}
          onBack={() => props.goTo('entry')}
        />
      );
    case 'configure':
      return (
        <ConfigureStep
          mode={props.state.mode}
          config={props.state.config}
          onChange={(config) =>
            props.setState((prev) => ({
              ...prev,
              config,
              duration: prev.duration === 0 ? suggestedDurationFor(config) : prev.duration,
            }))
          }
          onBack={() => props.goTo('mode')}
          onNext={() => props.goTo('metadata')}
        />
      );
    case 'metadata':
      return (
        <MetadataStep
          state={props.state}
          setState={props.setState}
          submit={props.submit}
          onBack={() => props.goTo('configure')}
        />
      );
  }
};

interface StepIndicatorProps {
  step: WizardStep;
}

const StepIndicator = ({ step }: StepIndicatorProps): React.JSX.Element => {
  const index = STEP_ORDER.indexOf(step);
  const label = `Step ${index + 1} of ${STEP_ORDER.length}: ${STEP_TITLES[step]}`;
  return (
    <View
      accessibilityRole="header"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      style={styles.indicator}
      testID="create-practice-step-indicator"
    >
      <Text style={styles.indicatorStep}>
        {index + 1} / {STEP_ORDER.length}
      </Text>
      <Text style={styles.indicatorTitle}>{STEP_TITLES[step]}</Text>
    </View>
  );
};

interface EntryStepProps {
  onPickPreset: () => void;
  onStartScratch: () => void;
}

const EntryStep = ({ onPickPreset, onStartScratch }: EntryStepProps): React.JSX.Element => (
  <View testID="create-practice-step-entry">
    <Text style={styles.bodyLead}>
      Most adepts find it fastest to copy a preset and tweak it. Start from scratch when no preset
      is close to what you have in mind.
    </Text>
    <PrimaryCard
      title="Start from a preset"
      subtitle="Browse the catalog and customize a copy."
      testID="create-practice-from-preset"
      onPress={onPickPreset}
    />
    <SecondaryCard
      title="Start from scratch"
      subtitle="Pick a mode, configure it, name it."
      testID="create-practice-from-scratch"
      onPress={onStartScratch}
    />
  </View>
);

interface ModeStepProps {
  mode: PickableMode | null;
  onSelect: (mode: PickableMode) => void;
  onBack: () => void;
}

const ModeStep = ({ mode, onSelect, onBack }: ModeStepProps): React.JSX.Element => (
  <View testID="create-practice-step-mode">
    <Text style={styles.bodyLead}>11 modes, grouped by intent. Tap one to configure it.</Text>
    <ModePicker selectedMode={mode} onSelect={onSelect} />
    <BackButton onPress={onBack} />
  </View>
);

interface ConfigureStepProps {
  mode: PickableMode | null;
  config: ModeConfig | null;
  onChange: (config: ModeConfig) => void;
  onBack: () => void;
  onNext: () => void;
}

const ConfigureStep = (props: ConfigureStepProps): React.JSX.Element => {
  const { mode, config } = props;
  if (mode === null) {
    return <NoticeView testID="create-practice-configure-empty" message="Pick a mode first." />;
  }
  if (config === null) {
    // Defensive: defaultConfigFor covers every mode, so this is unreachable in
    // practice — it guards against a future mode added without a default.
    return (
      <View testID="create-practice-step-configure">
        <NoticeView
          testID="create-practice-configure-unsupported"
          message="This mode isn't configurable in the wizard yet. Pick a different mode or wait for the next app update."
        />
        <BackButton onPress={props.onBack} />
      </View>
    );
  }
  const errors = validateModeConfig(config);
  const canProceed = errors.length === 0;
  return (
    <View testID="create-practice-step-configure">
      <Text style={styles.bodyLead}>
        Smart defaults are already filled in. Tweak anything that doesn&apos;t fit, or jump ahead to
        naming.
      </Text>
      <ConfiguratorBody config={config} onChange={props.onChange} />
      <ErrorList errors={errors} />
      <NavRow
        onBack={props.onBack}
        onNext={props.onNext}
        nextLabel="Next: name + save"
        nextDisabled={!canProceed}
        nextTestID="create-practice-configure-next"
      />
    </View>
  );
};

interface ConfiguratorBodyProps {
  config: ModeConfig;
  onChange: (next: ModeConfig) => void;
}

type FormComponent<M extends ModeConfig['mode']> = React.ComponentType<{
  value: Extract<ModeConfig, { mode: M }>;
  onChange: (next: Extract<ModeConfig, { mode: M }>) => void;
}>;

type FormTable = { [K in ModeConfig['mode']]: FormComponent<K> | null };

const MODE_FORMS: FormTable = {
  meditation_timer: MeditationTimerForm,
  count_up: CountUpForm,
  metronome: MetronomeForm,
  interval_bell: IntervalBellForm,
  random_interval_bell: RandomIntervalBellForm,
  rep_counter: RepCounterForm,
  sense_grounding: SenseGroundingForm,
  tarot: TarotForm,
  card_meditation: CardMeditationForm,
  tallied_grounding: TalliedGroundingForm,
  mindful_anchor: MindfulAnchorForm,
};

/** Title-case a mode key for user-facing copy (e.g. ``mindful_anchor`` → "Mindful anchor"). */
const humanizeMode = (mode: string): string => {
  const spaced = mode.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const ConfiguratorBody = ({ config, onChange }: ConfiguratorBodyProps): React.JSX.Element => {
  type AnyForm = React.ComponentType<{
    value: ModeConfig;
    onChange: (next: ModeConfig) => void;
  }>;
  const Form = MODE_FORMS[config.mode] as AnyForm | null;
  if (Form === null) {
    // Defensive: every current mode has a form, but if a future mode maps to
    // null the notice must name *that* mode, not a hardcoded one.
    return (
      <NoticeView
        testID="create-practice-configure-fallback"
        message={`${humanizeMode(config.mode)} will ship with a configurator soon. The defaults below will be saved as-is.`}
      />
    );
  }
  return <Form value={config} onChange={onChange} />;
};

interface MetadataStepProps {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  submit: SubmitController;
  onBack: () => void;
}

const MetadataStep = (props: MetadataStepProps): React.JSX.Element => {
  const errors = metadataErrors(props.state);
  const canSubmit = errors.length === 0 && !props.submit.busy;
  return (
    <View testID="create-practice-step-metadata">
      <NameField state={props.state} setState={props.setState} />
      <DescriptionField state={props.state} setState={props.setState} />
      <InstructionsField state={props.state} setState={props.setState} />
      <DurationField state={props.state} setState={props.setState} />
      <StageField state={props.state} setState={props.setState} />
      <ErrorList errors={errors} />
      {props.submit.apiError !== null && (
        <Text style={styles.apiError} testID="create-practice-api-error">
          {props.submit.apiError}
        </Text>
      )}
      <NavRow
        onBack={props.onBack}
        onNext={() => props.submit.run()}
        nextLabel={props.submit.busy ? 'Saving…' : 'Save practice'}
        nextDisabled={!canSubmit}
        nextTestID="create-practice-submit"
      />
    </View>
  );
};

interface MetadataFieldProps {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}

const NameField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => (
  <FieldLabel label="Name">
    <TextInput
      accessibilityLabel="Practice name"
      value={state.name}
      onChangeText={(name) => setState((prev) => ({ ...prev, name }))}
      placeholder="e.g. Awareness bells"
      maxLength={PRACTICE_NAME_MAX}
      style={styles.input}
      testID="create-practice-name"
    />
  </FieldLabel>
);

const DescriptionField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => (
  <FieldLabel label="Description (optional)">
    <TextInput
      accessibilityLabel="Practice description"
      value={state.description}
      onChangeText={(description) => setState((prev) => ({ ...prev, description }))}
      placeholder="One-liner you'll see in the catalog."
      maxLength={PRACTICE_DESCRIPTION_MAX}
      multiline
      style={[styles.input, styles.inputMultiline]}
      testID="create-practice-description"
    />
  </FieldLabel>
);

const InstructionsField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => (
  <FieldLabel label="Instructions (optional)">
    <TextInput
      accessibilityLabel="Practice instructions"
      value={state.instructions}
      onChangeText={(instructions) => setState((prev) => ({ ...prev, instructions }))}
      placeholder="How to do this practice."
      maxLength={PRACTICE_INSTRUCTIONS_MAX}
      multiline
      style={[styles.input, styles.inputMultiline]}
      testID="create-practice-instructions"
    />
  </FieldLabel>
);

const DurationField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => (
  <FieldLabel label="Default duration (minutes)">
    <TextInput
      accessibilityLabel="Default duration in minutes"
      value={state.duration === 0 ? '' : String(state.duration)}
      onChangeText={(raw) => setState((prev) => ({ ...prev, duration: parseDuration(raw) }))}
      keyboardType="number-pad"
      placeholder={state.config ? String(suggestedDurationFor(state.config)) : '10'}
      style={styles.input}
      testID="create-practice-duration"
    />
  </FieldLabel>
);

function parseDuration(raw: string): number {
  if (raw.length === 0) return 0;
  const trimmed = raw.replace(/[^0-9]/g, '');
  if (trimmed.length === 0) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

const StageField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => {
  const stages = Array.from({ length: MAX_STAGE - MIN_STAGE + 1 }, (_, i) => MIN_STAGE + i);
  return (
    <View style={styles.field} testID="create-practice-stage-field">
      <Text style={styles.fieldLabel}>Assign to a stage (optional)</Text>
      <Text style={styles.fieldHelp}>
        Pick a stage to make this your active practice for it right after saving.
      </Text>
      <View style={styles.stageRow}>
        <StageChip
          label="Skip"
          selected={state.stageNumber === null}
          onPress={() => setState((prev) => ({ ...prev, stageNumber: null }))}
          testID="create-practice-stage-skip"
        />
        {stages.map((n) => (
          <StageChip
            key={n}
            label={String(n)}
            selected={state.stageNumber === n}
            onPress={() => setState((prev) => ({ ...prev, stageNumber: n }))}
            testID={`create-practice-stage-${n}`}
          />
        ))}
      </View>
    </View>
  );
};

interface StageChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}

const StageChip = ({ label, selected, onPress, testID }: StageChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="radio"
    accessibilityLabel={`Stage ${label}`}
    accessibilityState={{ selected }}
    onPress={onPress}
    style={[styles.stageChip, selected && styles.stageChipSelected]}
    testID={testID}
  >
    <Text style={[styles.stageChipText, selected && styles.stageChipTextSelected]}>{label}</Text>
  </TouchableOpacity>
);

interface FieldLabelProps {
  label: string;
  children: React.ReactNode;
}

const FieldLabel = ({ label, children }: FieldLabelProps): React.JSX.Element => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    {children}
  </View>
);

interface PrimaryCardProps {
  title: string;
  subtitle: string;
  testID: string;
  onPress: () => void;
}

const PrimaryCard = ({ title, subtitle, testID, onPress }: PrimaryCardProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={title}
    onPress={onPress}
    style={[styles.entryCard, styles.entryCardPrimary]}
    testID={testID}
  >
    <Text style={[styles.entryCardTitle, styles.entryCardTitleLight]}>{title}</Text>
    <Text style={[styles.entryCardSubtitle, styles.entryCardSubtitleLight]}>{subtitle}</Text>
  </TouchableOpacity>
);

const SecondaryCard = ({
  title,
  subtitle,
  testID,
  onPress,
}: PrimaryCardProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={title}
    onPress={onPress}
    style={styles.entryCard}
    testID={testID}
  >
    <Text style={styles.entryCardTitle}>{title}</Text>
    <Text style={styles.entryCardSubtitle}>{subtitle}</Text>
  </TouchableOpacity>
);

interface BackButtonProps {
  onPress: () => void;
}

const BackButton = ({ onPress }: BackButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel="Back"
    onPress={onPress}
    style={styles.backButton}
    testID="create-practice-back"
  >
    <Text style={styles.backButtonText}>← Back</Text>
  </TouchableOpacity>
);

interface NavRowProps {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  nextTestID: string;
}

const NavRow = ({
  onBack,
  onNext,
  nextLabel,
  nextDisabled = false,
  nextTestID,
}: NavRowProps): React.JSX.Element => (
  <View style={styles.navRow}>
    <BackButton onPress={onBack} />
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={nextLabel}
      accessibilityState={{ disabled: nextDisabled }}
      onPress={nextDisabled ? undefined : onNext}
      style={[styles.primaryButton, nextDisabled && styles.disabledButton]}
      testID={nextTestID}
    >
      <Text style={styles.primaryButtonText}>{nextLabel}</Text>
    </TouchableOpacity>
  </View>
);

interface NoticeProps {
  message: string;
  testID: string;
}

const NoticeView = ({ message, testID }: NoticeProps): React.JSX.Element => (
  <View style={styles.notice} testID={testID}>
    <Text style={styles.noticeText}>{message}</Text>
  </View>
);

interface SubmitController {
  busy: boolean;
  apiError: string | null;
  run: () => Promise<void>;
}

function useSubmitController(
  props: CreatePracticeWizardProps,
  state: WizardState,
): SubmitController {
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const run = async () => {
    if (state.config === null) return;
    setBusy(true);
    setApiError(null);
    try {
      // ``stage_number`` is required on ``POST /practices/`` (catalog rows
      // are stage-scoped), so a "Skip stage" choice mints the draft under
      // FALLBACK_STAGE and skips the follow-up ``POST /user-practices``.
      // The draft is then stored but not active for any stage; the user
      // can assign it later from the detail screen. See
      // ``features/Practice/constants.ts`` for the rationale.
      const created = await practices.create({
        stage_number: state.stageNumber ?? FALLBACK_STAGE,
        name: state.name.trim(),
        description: state.description.trim(),
        instructions: state.instructions.trim(),
        default_duration_minutes: state.duration,
        mode: state.config.mode,
        mode_config: state.config,
      });
      if (state.stageNumber !== null) {
        await userPractices.create({
          practice_id: created.id,
          stage_number: state.stageNumber,
        });
      }
      props.navigation.replace('PracticeDetail', { practiceId: created.id });
    } catch (err) {
      setApiError(formatApiError(err, { fallback: 'Could not save practice.' }));
    } finally {
      setBusy(false);
    }
  };

  return { busy, apiError, run };
}

function metadataErrors(state: WizardState): string[] {
  const errors: string[] = [];
  if (state.name.trim().length < PRACTICE_NAME_MIN) {
    errors.push('Name is required.');
  }
  if (state.name.length > PRACTICE_NAME_MAX) {
    errors.push(`Name must be ≤ ${PRACTICE_NAME_MAX} characters.`);
  }
  if (state.description.length > PRACTICE_DESCRIPTION_MAX) {
    errors.push(`Description must be ≤ ${PRACTICE_DESCRIPTION_MAX} characters.`);
  }
  if (state.instructions.length > PRACTICE_INSTRUCTIONS_MAX) {
    errors.push(`Instructions must be ≤ ${PRACTICE_INSTRUCTIONS_MAX} characters.`);
  }
  if (!Number.isFinite(state.duration) || state.duration <= 0) {
    errors.push('Duration must be greater than 0.');
  }
  return errors;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background.primary },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl },
  indicator: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background.card,
  },
  indicatorStep: {
    fontSize: 12,
    color: colors.text.secondaryAccessible,
    fontWeight: '600',
  },
  indicatorTitle: { fontSize: 16, color: colors.text.primary, marginTop: 2 },
  bodyLead: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    marginBottom: SPACING.md,
  },
  entryCard: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  entryCardPrimary: { backgroundColor: colors.primary },
  entryCardTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  entryCardTitleLight: { color: colors.text.light },
  entryCardSubtitle: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    marginTop: SPACING.xs,
  },
  entryCardSubtitleLight: { color: colors.text.light, opacity: 0.85 },
  field: { marginBottom: SPACING.md },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: SPACING.xs,
  },
  fieldHelp: {
    fontSize: 12,
    color: colors.text.secondaryAccessible,
    marginBottom: SPACING.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: colors.text.primary,
    backgroundColor: colors.background.card,
  },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  stageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  stageChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background.card,
  },
  stageChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  stageChipText: { color: colors.text.primary, fontSize: 13, fontWeight: '600' },
  stageChipTextSelected: { color: colors.text.light },
  notice: {
    backgroundColor: colors.background.accent,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.md,
  },
  noticeText: { color: colors.text.primary, fontSize: 13 },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  backButton: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  backButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.sm,
  },
  primaryButtonText: { color: colors.text.light, fontWeight: '700', fontSize: 14 },
  disabledButton: { opacity: 0.5 },
  apiError: {
    color: colors.destructive.text,
    marginTop: SPACING.sm,
    fontSize: 13,
  },
});

export default CreatePracticeWizard;
