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

import { STAGE_DISPLAY } from '@/features/Map/mapLayout';

/** The controlled chord value: a primary Aspect and an optional secondary. */
export interface AspectChordValue {
  primary: number | null;
  secondary: number | null;
}

/** The empty chord used when no ``value`` is supplied. */
const EMPTY_CHORD: AspectChordValue = { primary: null, secondary: null };

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
}

interface AspectChipProps {
  option: AspectOption;
  selected: boolean;
  testID: string;
  onPress: () => void;
}

/** A single Aspect chip; announces its selection state to screen readers. */
function AspectChip({ option, selected, testID, onPress }: AspectChipProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.aspectChordChip, selected && styles.aspectChordChipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ selected }}
      testID={testID}
    >
      <Text style={[styles.aspectChordChipLabel, selected && styles.aspectChordChipLabelSelected]}>
        {option.label}
      </Text>
    </TouchableOpacity>
  );
}

interface AspectChipRowProps {
  prefix: string;
  selectedStage: number | null;
  omitStage: number | null;
  onSelect: (_stage: number) => void;
}

/** A wrapping row of Aspect chips, optionally omitting one stage. */
function AspectChipRow({
  prefix,
  selectedStage,
  omitStage,
  onSelect,
}: AspectChipRowProps): React.JSX.Element {
  return (
    <View style={styles.aspectChordRow} accessibilityRole="radiogroup">
      {ASPECT_OPTIONS.filter((option) => option.stage !== omitStage).map((option) => (
        <AspectChip
          key={option.stage}
          option={option}
          selected={option.stage === selectedStage}
          testID={`${prefix}-${option.stage}`}
          onPress={() => onSelect(option.stage)}
        />
      ))}
    </View>
  );
}

/** The collapsed state: a single warm trigger that reveals the chooser. */
function CollapsedTrigger({ onExpand }: { onExpand: () => void }): React.JSX.Element {
  return (
    <View style={styles.aspectChordControl}>
      <TouchableOpacity
        style={styles.aspectChordTrigger}
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={TRIGGER_LABEL}
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
}: Required<AspectChordControlProps>): React.JSX.Element {
  const primary = value.primary;
  return (
    <View style={styles.aspectChordControl} accessibilityLabel="Aspect chord">
      <Text style={styles.aspectChordSectionLabel}>Primary Aspect</Text>
      <AspectChipRow
        prefix="aspect-primary"
        selectedStage={primary}
        omitStage={null}
        onSelect={(stage) => onChange({ primary: stage, secondary: null })}
      />
      {primary === null ? null : (
        <View>
          <Text style={styles.aspectChordSectionLabel}>Secondary Aspect</Text>
          <AspectChipRow
            prefix="aspect-secondary"
            selectedStage={value.secondary}
            omitStage={primary}
            onSelect={(stage) => onChange({ primary, secondary: stage })}
          />
        </View>
      )}
      <TouchableOpacity
        style={styles.aspectChordClear}
        onPress={() => onChange(EMPTY_CHORD)}
        accessibilityRole="button"
        accessibilityLabel="Clear Aspect"
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
}: AspectChordControlProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (!expanded) {
    return <CollapsedTrigger onExpand={() => setExpanded(true)} />;
  }
  return <ExpandedChooser value={value} onChange={onChange} />;
}

export default AspectChordControl;
