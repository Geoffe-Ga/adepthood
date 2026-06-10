import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  GROUNDING_CATALOG,
  GROUNDING_GROUPS,
  type GroundingOption,
  SENSE_DISPLAY,
  findGroundingOption,
  searchGroundingCatalog,
} from '../../data/groundingCatalog';
import type { SenseKind, SensePrompt } from '../../engine/types';
import { ALLOWED_SENSES } from '../../engine/validation';

import { Chip } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

/** Tallest the open results panel grows before it scrolls internally. */
const PANEL_MAX_HEIGHT = 280;

interface Props {
  index: number;
  value: SensePrompt;
  /** Patch the owning prompt; the form merges it into its prompt list. */
  onChange: (patch: Partial<SensePrompt>) => void;
}

/**
 * Searchable replacement for the old five-chip sense selector.
 *
 * Closed, it shows the prompt's current anchor ("Red", or the raw custom
 * label) plus a sense badge. Open, it offers a search box, the grouped
 * {@link GROUNDING_CATALOG}, and a "create your own" affordance so the
 * library is a starting point rather than a fixed menu. Every choice
 * resolves to one backend {@link SenseKind}, so the stored config shape
 * never changes.
 */
const GroundingDropdown = ({ index, value, onChange }: Props): React.JSX.Element => {
  const dd = useGroundingDropdown(value, onChange);
  return (
    <View testID={`sense-prompt-${index}-thing`}>
      <Trigger
        index={index}
        label={triggerLabel(dd.selected, value)}
        sense={value.sense}
        open={dd.open}
        onPress={dd.toggle}
      />
      {dd.open && (
        <View style={styles.panel} testID={`sense-prompt-${index}-panel`}>
          <TextInput
            style={styles.search}
            value={dd.query}
            onChangeText={dd.setQuery}
            placeholder="Search things to notice…"
            autoCorrect={false}
            testID={`sense-prompt-${index}-search`}
          />
          {dd.query.trim() !== '' && (
            <CreateRow
              index={index}
              query={dd.query.trim()}
              createSense={dd.createSense}
              onPickSense={dd.setCreateSense}
              onCreate={dd.createCustom}
            />
          )}
          <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
            <GroupedOptions index={index} results={dd.results} onPick={dd.pickOption} />
          </ScrollView>
        </View>
      )}
    </View>
  );
};

interface DropdownController {
  open: boolean;
  query: string;
  createSense: SenseKind;
  results: readonly GroundingOption[];
  selected: GroundingOption | undefined;
  toggle: () => void;
  setQuery: (next: string) => void;
  setCreateSense: (next: SenseKind) => void;
  pickOption: (opt: GroundingOption) => void;
  createCustom: () => void;
}

/** Owns the open/search/create state so the view component stays declarative. */
function useGroundingDropdown(
  value: SensePrompt,
  onChange: (patch: Partial<SensePrompt>) => void,
): DropdownController {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [createSense, setCreateSense] = useState<SenseKind>(value.sense);
  const results = useMemo(() => searchGroundingCatalog(query), [query]);
  const close = (): void => {
    setOpen(false);
    setQuery('');
  };
  const pickOption = (opt: GroundingOption): void => {
    onChange({ sense: opt.sense, ...(labelIsDefault(value.label) ? { label: opt.prompt } : {}) });
    close();
  };
  const createCustom = (): void => {
    const label = query.trim();
    if (label === '') return;
    onChange({ sense: createSense, label });
    close();
  };
  return {
    open,
    query,
    createSense,
    results,
    selected: findGroundingOption(value.sense, value.label),
    toggle: () => setOpen((prev) => !prev),
    setQuery,
    setCreateSense,
    pickOption,
    createCustom,
  };
}

/** A prompt's label is "default" until the user edits it off a catalogue prompt. */
function labelIsDefault(label: string): boolean {
  return label.trim() === '' || GROUNDING_CATALOG.some((opt) => opt.prompt === label);
}

function triggerLabel(selected: GroundingOption | undefined, value: SensePrompt): string {
  if (selected !== undefined) return selected.label;
  if (value.label.trim() !== '') return value.label.trim();
  return 'Choose what to notice';
}

interface TriggerProps {
  index: number;
  label: string;
  sense: SenseKind;
  open: boolean;
  onPress: () => void;
}

const Trigger = ({ index, label, sense, open, onPress }: TriggerProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`Choose what to notice, currently ${label}`}
    accessibilityState={{ expanded: open }}
    onPress={onPress}
    style={styles.trigger}
    testID={`sense-prompt-${index}-thing-trigger`}
  >
    <Text style={styles.triggerLabel} numberOfLines={1}>
      {label}
    </Text>
    <View style={styles.triggerRight}>
      <Text style={styles.senseBadge} testID={`sense-prompt-${index}-sense-badge`}>
        {SENSE_DISPLAY[sense]}
      </Text>
      <Text style={styles.caret}>{open ? '▲' : '▼'}</Text>
    </View>
  </TouchableOpacity>
);

interface CreateRowProps {
  index: number;
  query: string;
  createSense: SenseKind;
  onPickSense: (sense: SenseKind) => void;
  onCreate: () => void;
}

const CreateRow = ({
  index,
  query,
  createSense,
  onPickSense,
  onCreate,
}: CreateRowProps): React.JSX.Element => (
  <View style={styles.createSection} testID={`sense-prompt-${index}-create-section`}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Use ${query} as a custom thing to notice`}
      onPress={onCreate}
      style={styles.createRow}
      testID={`sense-prompt-${index}-create`}
    >
      <Text style={styles.createText} numberOfLines={1}>
        {`+ Use “${query}”`}
      </Text>
    </TouchableOpacity>
    <View style={styles.createSenses}>
      <Text style={styles.createSensesLabel}>Sense</Text>
      {ALLOWED_SENSES.map((sense) => (
        <Chip
          key={sense}
          label={SENSE_DISPLAY[sense]}
          active={createSense === sense}
          onPress={() => onPickSense(sense)}
          testID={`sense-prompt-${index}-create-sense-${sense}`}
        />
      ))}
    </View>
  </View>
);

interface GroupedOptionsProps {
  index: number;
  results: readonly GroundingOption[];
  onPick: (opt: GroundingOption) => void;
}

const GroupedOptions = ({ index, results, onPick }: GroupedOptionsProps): React.JSX.Element => {
  if (results.length === 0) {
    return (
      <Text style={styles.empty} testID={`sense-prompt-${index}-empty`}>
        No matches — create your own above.
      </Text>
    );
  }
  return (
    <>
      {GROUNDING_GROUPS.map((group) => {
        const inGroup = results.filter((opt) => opt.group === group);
        if (inGroup.length === 0) return null;
        return (
          <View key={group} testID={`sense-prompt-${index}-group-${group}`}>
            <Text style={styles.groupHeader}>{group}</Text>
            {inGroup.map((opt) => (
              <OptionRow key={opt.id} index={index} option={opt} onPick={() => onPick(opt)} />
            ))}
          </View>
        );
      })}
    </>
  );
};

interface OptionRowProps {
  index: number;
  option: GroundingOption;
  onPick: () => void;
}

const OptionRow = ({ index, option, onPick }: OptionRowProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`${option.label}, noticed through ${SENSE_DISPLAY[option.sense]}`}
    onPress={onPick}
    style={styles.optionRow}
    testID={`sense-prompt-${index}-option-${option.id}`}
  >
    <Text style={styles.optionLabel}>{option.label}</Text>
    <Text style={styles.optionPrompt} numberOfLines={1}>
      {option.prompt}
    </Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    backgroundColor: colors.background.card,
    gap: SPACING.sm,
  },
  triggerLabel: { color: colors.text.primary, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  triggerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  senseBadge: {
    color: colors.text.secondaryAccessible,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
  },
  caret: { color: colors.text.secondaryAccessible, fontSize: 11 },
  panel: {
    marginTop: SPACING.xs,
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.card,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  search: {
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    color: colors.text.primary,
    fontSize: 14,
    backgroundColor: colors.background.primary,
  },
  results: { maxHeight: PANEL_MAX_HEIGHT },
  groupHeader: {
    color: colors.text.tertiaryAccessible,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: SPACING.xs,
    marginBottom: 2,
  },
  optionRow: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  optionLabel: { color: colors.text.primary, fontSize: 14, fontWeight: '500' },
  optionPrompt: { color: colors.text.secondaryAccessible, fontSize: 12 },
  empty: { color: colors.text.secondaryAccessible, fontSize: 13, padding: SPACING.sm },
  createSection: {
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  createRow: { paddingVertical: SPACING.xs, paddingHorizontal: SPACING.xs },
  createText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  createSenses: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs },
  createSensesLabel: { color: colors.text.secondaryAccessible, fontSize: 12, fontWeight: '600' },
});

export default GroundingDropdown;
