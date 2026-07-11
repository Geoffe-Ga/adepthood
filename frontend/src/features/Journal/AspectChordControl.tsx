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
 */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import styles from './JournalEntry.styles';

import { RadioGroup, RadioOption } from '@/components/RadioOption';
import { STAGE_DISPLAY } from '@/features/Map/mapLayout';

/** The controlled chord value: a primary Aspect and an optional secondary. */
export interface AspectChordValue {
  primary: number | null;
  secondary: number | null;
}

/** The empty chord used when no ``value`` is supplied. */
export const EMPTY_CHORD: AspectChordValue = { primary: null, secondary: null };

/** Warm, declinable copy for the collapsed trigger. */
const TRIGGER_LABEL = 'Name an Aspect (optional)';

/** One offered Aspect: its stage number and the persona label to show. */
interface AspectOption {
  stage: number;
  label: string;
}

/** The stages offered as Aspects, ascending (1..10), labelled by persona. */
const ASPECT_OPTIONS: readonly AspectOption[] = Object.entries(STAGE_DISPLAY)
  .map(([key, display]) => ({ stage: Number(key), label: display.persona }))
  .sort((a, b) => a.stage - b.stage);

export interface AspectChordControlProps {
  /** The current chord; defaults to an empty (untagged) chord when omitted. */
  value?: AspectChordValue;
  /** Called with the next chord whenever a chip or the clear affordance fires. */
  onChange: (_next: AspectChordValue) => void;
  /** When true, the trigger won't expand and changes are inert (failed load). */
  disabled?: boolean;
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
        <RadioOption
          key={option.stage}
          label={option.label}
          selected={option.stage === selectedStage}
          onPress={() => onSelect(option.stage)}
          disabled={disabled}
          testID={`${prefix}-${option.stage}`}
          style={styles.aspectChordChip}
          selectedStyle={styles.aspectChordChipSelected}
          labelStyle={styles.aspectChordChipLabel}
          selectedLabelStyle={styles.aspectChordChipLabelSelected}
        />
      ))}
    </RadioGroup>
  );
}

/** The collapsed state: a single warm trigger that reveals the chooser. */
function CollapsedTrigger({
  onExpand,
  disabled,
}: {
  onExpand: () => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.aspectChordControl}>
      <TouchableOpacity
        style={styles.aspectChordTrigger}
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={TRIGGER_LABEL}
        accessibilityState={{ disabled }}
        testID="aspect-chord-trigger"
      >
        <Text style={styles.aspectChordTriggerLabel}>{TRIGGER_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** The expanded state: primary chips, optional secondary chips, and a clear. */
function ExpandedChooser({
  value,
  onChange,
  disabled,
}: Required<Pick<AspectChordControlProps, 'value' | 'onChange' | 'disabled'>>): React.JSX.Element {
  const primary = value.primary;
  return (
    <View style={styles.aspectChordControl} accessibilityLabel="Aspect chord">
      <Text style={styles.aspectChordSectionLabel}>Primary Aspect</Text>
      <AspectChipRow
        prefix="aspect-primary"
        selectedStage={primary}
        omitStage={null}
        onSelect={(stage) => onChange({ primary: stage, secondary: null })}
        disabled={disabled}
      />
      {primary === null ? null : (
        <View>
          <Text style={styles.aspectChordSectionLabel}>Secondary Aspect</Text>
          <AspectChipRow
            prefix="aspect-secondary"
            selectedStage={value.secondary}
            omitStage={primary}
            onSelect={(stage) => onChange({ primary, secondary: stage })}
            disabled={disabled}
          />
        </View>
      )}
      <TouchableOpacity
        style={styles.aspectChordClear}
        onPress={() => onChange(EMPTY_CHORD)}
        accessibilityRole="button"
        accessibilityLabel="Clear Aspect"
        accessibilityState={{ disabled }}
        testID="aspect-chord-clear"
      >
        <Text style={styles.aspectChordClearLabel}>Clear</Text>
      </TouchableOpacity>
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
  // mount, as it does on the edit screen. The user's own tap latches it open too.
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = userExpanded || value.primary !== null;
  if (!expanded) {
    // A disabled control (failed load) never reveals its chips on tap.
    const onExpand = (): void => {
      if (!disabled) setUserExpanded(true);
    };
    return <CollapsedTrigger onExpand={onExpand} disabled={disabled} />;
  }
  // Latch the control open once the writer acts inside it, so pressing Clear on
  // an edit-loaded chord leaves them on the chips to re-pick rather than snapping
  // back to the collapsed "optional" trigger mid-edit. Inert while disabled.
  const handleChange = (next: AspectChordValue): void => {
    if (disabled) return;
    setUserExpanded(true);
    onChange(next);
  };
  return <ExpandedChooser value={value} onChange={handleChange} disabled={disabled} />;
}

export default AspectChordControl;
