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
 * already active for that stage. Submissions navigate to ``PracticeDetail``
 * for the brand-new row; if the stage-assign step fails the failure message
 * is carried along in the ``assignError`` route param so the detail screen
 * can surface it (the draft still exists, so the user retries there rather
 * than staying stuck in the wizard).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { defaultConfigFor, isDurationDriven, suggestedDurationFor } from '../configurator/defaults';
import { ErrorList } from '../configurator/forms/shared';
import type { ModeConfig } from '../engine/types';
import { validateModeConfig } from '../engine/validation';

import { practices, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  surface,
  surfaceShadow,
} from '@/design/tokens';
import ConfiguratorBody from '@/features/Practice/components/ConfiguratorBody';
import ModePicker, { type PickableMode } from '@/features/Practice/components/ModePicker';
import { FALLBACK_STAGE, stageRange } from '@/features/Practice/constants';
import { formatDuration } from '@/features/Practice/utils/formatDuration';
import { parsePositiveInt } from '@/features/Practice/utils/parsePositiveInt';
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
  const insets = useSafeAreaInsets();
  // Insets live on an outer View (not the KeyboardAvoidingView, which owns its
  // own bottom padding from the keyboard height); the KAV composes inside it.
  return (
    <View
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="create-practice-wizard"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.screen}
        testID="create-practice-keyboard-avoider"
      >
        <StepIndicator step={state.step} />
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <StepView
            state={state}
            setState={setState}
            goTo={goTo}
            setMode={setMode}
            submit={submit}
            onPickPreset={() => props.navigation.navigate('Catalog')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
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
      <View style={styles.progressTrack}>
        {STEP_ORDER.map((s, i) => (
          <View
            key={s}
            style={[styles.progressSegment, i <= index && styles.progressSegmentFilled]}
          />
        ))}
      </View>
      <Text style={styles.indicatorStep}>
        Step {index + 1} of {STEP_ORDER.length}
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
    <EntryCard
      title="Start from a preset"
      subtitle="Customize a copy from the catalog."
      testID="create-practice-from-preset"
      onPress={onPickPreset}
    />
    <EntryCard
      title="Start from scratch"
      subtitle="Pick a mode and configure it."
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
    <Text style={styles.bodyLead}>Grouped by intent — tap one to configure.</Text>
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
      <Text style={styles.bodyLead}>Defaults are filled in — tweak or continue.</Text>
      <ConfiguratorBody
        config={config}
        onChange={props.onChange}
        renderFallback={renderWizardFallback}
      />
      <ErrorList errors={errors} />
      <NavRow
        onBack={props.onBack}
        onNext={props.onNext}
        nextLabel="Next"
        nextDisabled={!canProceed}
        nextTestID="create-practice-configure-next"
      />
    </View>
  );
};

/** Title-case a mode key for user-facing copy (e.g. ``mindful_anchor`` → "Mindful anchor"). */
const humanizeMode = (mode: string): string => {
  const spaced = mode.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

// Defensive: every current mode has a form, but if a future mode maps to null
// the notice must name *that* mode, not a hardcoded one.
const renderWizardFallback = (mode: string): React.JSX.Element => (
  <NoticeView
    testID="create-practice-configure-fallback"
    message={`${humanizeMode(mode)} will ship with a configurator soon. The defaults below will be saved as-is.`}
  />
);

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
      {showsDurationField(props.state) && (
        <DurationField state={props.state} setState={props.setState} />
      )}
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

const DurationField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => {
  const suggested = state.config ? suggestedDurationFor(state.config) : 10;
  return (
    <FieldLabel label="Default duration (minutes)">
      <TextInput
        accessibilityLabel="Default duration in minutes"
        value={state.duration === 0 ? '' : String(state.duration)}
        onChangeText={(raw) =>
          setState((prev) => ({ ...prev, duration: parsePositiveInt(raw) ?? 0 }))
        }
        keyboardType="number-pad"
        placeholder={String(suggested)}
        style={styles.input}
        testID="create-practice-duration"
      />
      <Text style={styles.fieldHelp} testID="create-practice-duration-suggested">
        Suggested: {formatDuration(suggested)}
      </Text>
    </FieldLabel>
  );
};

const StageField = ({ state, setState }: MetadataFieldProps): React.JSX.Element => {
  const stages = stageRange();
  return (
    <View style={styles.field} testID="create-practice-stage-field">
      <Text style={styles.fieldLabel}>Assign to a stage (optional)</Text>
      <Text style={styles.fieldHelp}>Makes this your active practice for that stage.</Text>
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

interface EntryCardProps {
  title: string;
  subtitle: string;
  testID: string;
  onPress: () => void;
}

const EntryCard = ({ title, subtitle, testID, onPress }: EntryCardProps): React.JSX.Element => (
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

/**
 * Create the catalog draft, or reuse the one minted on an earlier tap.
 *
 * ``stage_number`` is required on ``POST /practices/`` (catalog rows are
 * stage-scoped), so a "Skip stage" choice mints the draft under
 * FALLBACK_STAGE. The id is cached in ``draftIdRef`` so a retry after a
 * failed stage-assign only re-tries the assign step instead of minting a
 * second draft. See ``features/Practice/constants.ts`` for the rationale.
 * Note: edits made after the draft is minted are not re-sent on retry — the
 * cached row is reused as-is.
 */
async function createOrReuseDraft(
  state: WizardState,
  config: ModeConfig,
  draftIdRef: React.MutableRefObject<number | null>,
): Promise<number> {
  if (draftIdRef.current !== null) return draftIdRef.current;
  const created = await practices.create({
    stage_number: state.stageNumber ?? FALLBACK_STAGE,
    name: state.name.trim(),
    description: state.description.trim(),
    instructions: state.instructions.trim(),
    default_duration_minutes: deriveDefaultDuration(config, state.duration),
    mode: config.mode,
    mode_config: config,
  });
  draftIdRef.current = created.id;
  return created.id;
}

/**
 * Reconcile ``default_duration_minutes`` with the timer's own duration.
 *
 * For a duration-driven mode the countdown lives in ``mode_config`` (e.g.
 * ``metronome.timer.duration_minutes``), so the saved default is derived
 * from it — the standalone field is hidden and the two numbers agree. Every
 * other mode threads the user-typed field value through unchanged.
 */
function deriveDefaultDuration(config: ModeConfig, typedDuration: number): number {
  return isDurationDriven(config.mode) ? suggestedDurationFor(config) : typedDuration;
}

/** The standalone duration field shows only for modes without an inherent duration. */
function showsDurationField(state: WizardState): boolean {
  return state.config === null || !isDurationDriven(state.config.mode);
}

/**
 * Assign the draft as the active practice for the pinned stage.
 *
 * A stage-assign failure is recoverable — the draft already exists — so the
 * error message is returned (not thrown) and carried to ``PracticeDetail``
 * via the ``assignError`` route param, where the user retries rather than
 * staying trapped in the wizard. Returns ``null`` on success (or when no
 * stage was pinned); the caught message otherwise.
 */
async function tryAssign(
  practiceId: number,
  stageNumber: number | null,
  draftIdRef: React.MutableRefObject<number | null>,
): Promise<string | null> {
  if (stageNumber === null) {
    draftIdRef.current = null;
    return null;
  }
  try {
    await userPractices.create({ practice_id: practiceId, stage_number: stageNumber });
    draftIdRef.current = null;
    return null;
  } catch (err) {
    return formatApiError(err, { fallback: 'Could not assign practice to the stage.' });
  }
}

function navigateToDetail(
  props: CreatePracticeWizardProps,
  practiceId: number,
  assignError: string | null,
): void {
  if (assignError === null) {
    props.navigation.replace('PracticeDetail', { practiceId });
    return;
  }
  props.navigation.replace('PracticeDetail', { practiceId, assignError });
}

function useSubmitController(
  props: CreatePracticeWizardProps,
  state: WizardState,
): SubmitController {
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  // Remembers the draft minted this wizard session so a retry after a failed
  // stage-assign reuses it instead of creating a duplicate catalog row.
  const draftIdRef = useRef<number | null>(null);

  const run = async () => {
    if (state.config === null) return;
    setBusy(true);
    setApiError(null);
    let practiceId: number | null = null;
    let assignError: string | null = null;
    try {
      practiceId = await createOrReuseDraft(state, state.config, draftIdRef);
    } catch (err) {
      setApiError(formatApiError(err, { fallback: 'Could not save practice.' }));
    }
    if (practiceId !== null) {
      assignError = await tryAssign(practiceId, state.stageNumber, draftIdRef);
    }
    setBusy(false);
    // The draft exists once ``createOrReuseDraft`` returns, so navigate even
    // when the stage-assign failed. On failure the user lands on the detail
    // screen with the message shown via the ``assignError`` route param, where
    // they retry via "Use for stage" rather than staying stuck in the wizard.
    // ``draftIdRef`` is only cleared on a successful assign (in ``tryAssign``),
    // so a retry reuses the same draft instead of minting a duplicate.
    if (practiceId !== null) {
      navigateToDetail(props, practiceId, assignError);
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
  screen: { flex: 1, backgroundColor: surface.canvas },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl },
  indicator: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  progressTrack: { flexDirection: 'row', gap: SPACING.xs, marginBottom: SPACING.sm },
  progressSegment: {
    flex: 1,
    height: 3,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: surface.hairline,
  },
  progressSegmentFilled: { backgroundColor: accent.primary },
  indicatorStep: {
    ...editorialType.caption,
    color: ink.soft,
    fontWeight: '600',
  },
  indicatorTitle: { ...editorialType.title, color: ink.primary, marginTop: 2 },
  bodyLead: {
    ...editorialType.body,
    color: ink.soft,
    marginBottom: SPACING.md,
  },
  entryCard: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...surfaceShadow.card,
  },
  entryCardTitle: { ...editorialType.title, color: ink.primary },
  entryCardSubtitle: {
    ...editorialType.caption,
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  field: { marginBottom: SPACING.md },
  fieldLabel: {
    ...editorialType.note,
    color: ink.primary,
    marginBottom: SPACING.xs,
  },
  fieldHelp: {
    ...editorialType.caption,
    color: ink.soft,
    marginBottom: SPACING.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: 14,
    color: ink.primary,
    backgroundColor: surface.raised,
  },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  stageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  stageChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  stageChipSelected: { backgroundColor: accent.primary, borderColor: accent.primary },
  stageChipText: { ...editorialType.note, color: ink.primary },
  stageChipTextSelected: { color: surface.raised },
  notice: {
    backgroundColor: surface.sunken,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.md,
  },
  noticeText: { ...editorialType.caption, color: ink.primary },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  backButton: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  backButtonText: { ...editorialType.note, color: accent.primary },
  primaryButton: {
    backgroundColor: accent.primary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
  },
  primaryButtonText: { color: surface.raised, fontWeight: '700', fontSize: 14 },
  disabledButton: { opacity: 0.5 },
  apiError: {
    color: colors.destructive.text,
    marginTop: SPACING.sm,
    fontSize: 13,
  },
});

export default CreatePracticeWizard;
