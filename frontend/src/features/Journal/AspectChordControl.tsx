/**
 * ``AspectChordControl`` — an optional, declinable chooser for a journal
 * entry's chord: a primary Aspect and, atop it, a secondary Aspect (each a
 * curriculum stage 1..10). It starts collapsed behind a warm trigger so the
 * writer only meets it if they want it — nothing here is required and no rank
 * or progress is implied.
 *
 * Presentational and controlled: ``onChange`` is the only output; the host owns
 * the chord value and persists it (create/update). Picking a primary clears any
 * secondary; the secondary chips omit the chosen primary so the two notes
 * always differ.
 *
 * Each voice folds down to its choice once it has one, and the whole control can
 * be collapsed back to the trigger, so a named chord costs the writing column a
 * couple of lines rather than nineteen chips.
 */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import styles from './JournalEntry.styles';

import { RadioGroup } from '@/components/RadioOption';
import { STAGE_ORDER, readableGlyphOn, resolveStageColor } from '@/design/tokens';
import { STAGE_DISPLAY } from '@/features/Map/mapLayout';

/** The controlled chord value: a primary Aspect and an optional secondary. */
export interface AspectChordValue {
  primary: number | null;
  secondary: number | null;
}

/** The empty chord used when no ``value`` is supplied. */
export const EMPTY_CHORD: AspectChordValue = { primary: null, secondary: null };

/** Warm, declinable copy for the collapsed trigger when nothing is named. */
const TRIGGER_LABEL = 'Name an Aspect (optional)';

/** Prefix marking the chosen chip without relying on its colour (WCAG 1.4.1). */
const CHOSEN_MARK = '✓';

/** Separator between the two voices when the collapsed trigger names a chord. */
const CHORD_SEPARATOR = ' · ';

/** The two voices of a chord, in the order they are chosen. */
const PRIMARY = 'primary';
const SECONDARY = 'secondary';
type AspectRole = typeof PRIMARY | typeof SECONDARY;

/** Section copy for each voice, reused in its Change affordance's name. */
const ROLE_LABEL: Record<AspectRole, string> = {
  [PRIMARY]: 'Primary Aspect',
  [SECONDARY]: 'Secondary Aspect',
};

export interface AspectChordControlProps {
  /** The current chord; defaults to an empty (untagged) chord when omitted. */
  value?: AspectChordValue;
  /** Called with the next chord whenever a chip or the clear affordance fires. */
  onChange: (_next: AspectChordValue) => void;
  /** When true, the trigger won't expand and changes are inert (failed load). */
  disabled?: boolean;
}

/** One offered Aspect: its stage number and the persona label to show. */
interface AspectOption {
  stage: number;
  label: string;
}

/** The stages offered as Aspects, ascending (1..10), labelled by persona. */
const ASPECT_OPTIONS: readonly AspectOption[] = Object.entries(STAGE_DISPLAY)
  .map(([key, display]) => ({ stage: Number(key), label: display.persona }))
  .sort((a, b) => a.stage - b.stage);

/** The persona a stage is offered under, or an empty label if it has none. */
function personaFor(stage: number): string {
  const display = STAGE_DISPLAY[stage];
  return display === undefined ? '' : display.persona;
}

/**
 * This stage's colour, from the one per-stage palette the app already shares.
 *
 * Stages, Aspects, Modes and Frequencies are a single set of ten positions
 * joined on colour, and ``design/tokens`` holds the app-wide swatch for each —
 * mirrored from the backend's table and guarded against drifting from it. The
 * Map keeps its own colours, but its module says why: they are tuned to the
 * spiral artwork rather than to the app, so they are not the palette a chip
 * outside the Map should read.
 */
function stageFill(stage: number): string {
  return resolveStageColor(STAGE_ORDER[stage - 1]);
}

interface AspectChipProps {
  stage: number;
  selected: boolean;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}

/**
 * One Aspect chip, coloured by its stage.
 *
 * Deliberately not a {@link RadioOption}: that primitive's adoption criteria
 * exclude an option whose look carries a runtime-injected colour, and say to
 * keep such a control local rather than bend it. Its a11y contract is mirrored
 * exactly — the visible persona is the accessible name, and selection is
 * announced through ``accessibilityState.selected``.
 *
 * Chosen chips take the stage's own fill with a foreground the shared resolver
 * picks for contrast against it; unchosen chips keep the paper ground their
 * ink-soft label was audited on and wear the stage colour on their border.
 */
function AspectChip({
  stage,
  selected,
  onPress,
  disabled,
  testID,
}: AspectChipProps): React.JSX.Element {
  const fill = stageFill(stage);
  const label = personaFor(stage);
  const container = selected
    ? [styles.aspectChordChip, styles.aspectChordChipSelected, { backgroundColor: fill }]
    : [styles.aspectChordChip, { borderColor: fill }];
  const labelStyle = selected
    ? [styles.aspectChordChipLabel, { color: readableGlyphOn(fill) }]
    : styles.aspectChordChipLabel;
  return (
    <TouchableOpacity
      style={container}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      testID={testID}
    >
      <Text style={labelStyle} testID={`${testID}-label`}>
        {selected ? `${CHOSEN_MARK} ${label}` : label}
      </Text>
    </TouchableOpacity>
  );
}

interface AspectChipRowProps {
  prefix: string;
  selectedStage: number | null;
  omitStage: number | null;
  onSelect: (_stage: number) => void;
  disabled: boolean;
}

/** A wrapping row of Aspect chips, optionally omitting one stage. */
function AspectChipRow({
  prefix,
  selectedStage,
  omitStage,
  onSelect,
  disabled,
}: AspectChipRowProps): React.JSX.Element {
  return (
    <RadioGroup style={styles.aspectChordRow}>
      {ASPECT_OPTIONS.filter((option) => option.stage !== omitStage).map((option) => (
        <AspectChip
          key={option.stage}
          stage={option.stage}
          selected={option.stage === selectedStage}
          onPress={() => onSelect(option.stage)}
          disabled={disabled}
          testID={`${prefix}-${option.stage}`}
        />
      ))}
    </RadioGroup>
  );
}

interface ChordActionProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}

/** A quiet text affordance on the chooser: Clear, Collapse, or a row's Change. */
function ChordAction({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  testID,
}: ChordActionProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.aspectChordAction}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      testID={testID}
    >
      <Text style={styles.aspectChordActionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

interface AspectStepProps {
  role: AspectRole;
  selectedStage: number | null;
  omitStage: number | null;
  /** True while the writer is re-picking this voice, which reopens its row. */
  picking: boolean;
  onReopen: () => void;
  onSelect: (_stage: number) => void;
  disabled: boolean;
}

/**
 * One voice of the chord. Until it is chosen it offers every Aspect; once it is,
 * it folds onto a single line — its label, the chosen chip, and a Change that
 * reopens the row — which is what gives the writing column its space back.
 */
function AspectStep({
  role,
  selectedStage,
  omitStage,
  picking,
  onReopen,
  onSelect,
  disabled,
}: AspectStepProps): React.JSX.Element {
  const prefix = `aspect-${role}`;
  if (selectedStage !== null && !picking) {
    return (
      <View style={styles.aspectChordChosenRow}>
        <Text style={styles.aspectChordSectionLabel}>{ROLE_LABEL[role]}</Text>
        <AspectChip
          stage={selectedStage}
          selected
          onPress={onReopen}
          disabled={disabled}
          testID={`${prefix}-${selectedStage}`}
        />
        <ChordAction
          label="Change"
          accessibilityLabel={`Change ${ROLE_LABEL[role]}`}
          onPress={onReopen}
          disabled={disabled}
          testID={`${prefix}-change`}
        />
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.aspectChordSectionLabel}>{ROLE_LABEL[role]}</Text>
      <AspectChipRow
        prefix={prefix}
        selectedStage={selectedStage}
        omitStage={omitStage}
        onSelect={onSelect}
        disabled={disabled}
      />
    </View>
  );
}

/** What the collapsed trigger says: the invitation, or the chord already named. */
function triggerLabel(value: AspectChordValue): string {
  const { primary, secondary } = value;
  if (primary === null) return TRIGGER_LABEL;
  const named = personaFor(primary);
  if (secondary === null) return `Aspect: ${named}`;
  return `Aspect: ${named}${CHORD_SEPARATOR}${personaFor(secondary)}`;
}

/** The collapsed state: a single warm trigger that reveals the chooser. */
function CollapsedTrigger({
  label,
  onExpand,
  disabled,
}: {
  label: string;
  onExpand: () => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.aspectChordControl}>
      <TouchableOpacity
        style={styles.aspectChordTrigger}
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        testID="aspect-chord-trigger"
      >
        <Text style={styles.aspectChordTriggerLabel}>{label}</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The chord-level affordances on one line. Clear untags the entry and leaves the
 * writer on the chips to re-pick; Collapse gives the writing column its space
 * back without untagging anything. They are separate because those are separate
 * wishes, and the writer usually wants the second one after the first.
 */
function ChordFooter({
  onClear,
  onCollapse,
  disabled,
}: {
  onClear: () => void;
  onCollapse: () => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.aspectChordActions}>
      <ChordAction
        label="Clear"
        accessibilityLabel="Clear Aspect"
        onPress={onClear}
        disabled={disabled}
        testID="aspect-chord-clear"
      />
      <ChordAction
        label="Collapse"
        accessibilityLabel="Collapse the Aspect chooser"
        onPress={onCollapse}
        disabled={disabled}
        testID="aspect-chord-collapse"
      />
    </View>
  );
}

interface ExpandedChooserProps {
  value: AspectChordValue;
  onChange: (_next: AspectChordValue) => void;
  onCollapse: () => void;
  disabled: boolean;
}

/** The expanded state: the two voices, then the chord-level Clear and Collapse. */
function ExpandedChooser({
  value,
  onChange,
  onCollapse,
  disabled,
}: ExpandedChooserProps): React.JSX.Element {
  // Which voice, if any, the writer has reopened to re-pick. Choosing folds it
  // back down, so at most one full chip row is ever open.
  const [picking, setPicking] = useState<AspectRole | null>(null);
  const primary = value.primary;
  const reopen = (role: AspectRole) => (): void => {
    if (!disabled) setPicking(role);
  };
  const choose = (next: AspectChordValue): void => {
    setPicking(null);
    onChange(next);
  };
  return (
    <View style={styles.aspectChordControl} accessibilityLabel="Aspect chord">
      <AspectStep
        role={PRIMARY}
        selectedStage={primary}
        omitStage={null}
        picking={picking === PRIMARY}
        onReopen={reopen(PRIMARY)}
        onSelect={(stage) => choose({ primary: stage, secondary: null })}
        disabled={disabled}
      />
      {primary === null ? null : (
        <AspectStep
          role={SECONDARY}
          selectedStage={value.secondary}
          omitStage={primary}
          picking={picking === SECONDARY}
          onReopen={reopen(SECONDARY)}
          onSelect={(stage) => choose({ primary, secondary: stage })}
          disabled={disabled}
        />
      )}
      <ChordFooter
        onClear={() => choose(EMPTY_CHORD)}
        onCollapse={onCollapse}
        disabled={disabled}
      />
    </View>
  );
}

/**
 * The collapsible Aspect chord chooser. Rendered in the writing column of
 * {@link JournalEntryScreen}, beside the privacy control.
 */
function AspectChordControl({
  value = EMPTY_CHORD,
  onChange,
  disabled = false,
}: AspectChordControlProps): React.JSX.Element {
  // Derive expansion from the value so a loaded (pre-tagged) entry opens on its
  // chips instead of the "optional" trigger — even when the chord arrives after
  // mount, as it does on the edit screen. The user's own tap latches it open too,
  // and an explicit Collapse overrides both: a writer who has named their chord
  // can take the space back without untagging the entry to do it.
  const [userExpanded, setUserExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const expanded = !collapsed && (userExpanded || value.primary !== null);
  if (!expanded) {
    // A disabled control (failed load) never reveals its chips on tap.
    const onExpand = (): void => {
      if (disabled) return;
      setCollapsed(false);
      setUserExpanded(true);
    };
    return <CollapsedTrigger label={triggerLabel(value)} onExpand={onExpand} disabled={disabled} />;
  }
  // Latch the control open once the writer acts inside it, so pressing Clear on
  // an edit-loaded chord leaves them on the chips to re-pick rather than snapping
  // back to the collapsed "optional" trigger mid-edit. Inert while disabled.
  const handleChange = (next: AspectChordValue): void => {
    if (disabled) return;
    setUserExpanded(true);
    onChange(next);
  };
  const handleCollapse = (): void => {
    if (!disabled) setCollapsed(true);
  };
  return (
    <ExpandedChooser
      value={value}
      onChange={handleChange}
      onCollapse={handleCollapse}
      disabled={disabled}
    />
  );
}

export default AspectChordControl;
