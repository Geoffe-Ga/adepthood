import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import SearchableDropdown, {
  DropdownEmptyState,
  DropdownGroupHeader,
  DropdownOptionRow,
  dropdownCreateStyles,
} from '../../components/SearchableDropdown';
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
 * {@link GROUNDING_CATALOG}, and a "create your own" affordance. Every
 * choice resolves to one backend {@link SenseKind}, so the stored config
 * shape never changes.
 */
const GroundingDropdown = ({ index, value, onChange }: Props): React.JSX.Element => {
  const base = `sense-prompt-${index}`;
  const dd = useGroundingDropdown(value, onChange);
  return (
    <SearchableDropdown
      testID={`${base}-thing`}
      triggerTestID={`${base}-thing-trigger`}
      panelTestID={`${base}-panel`}
      searchTestID={`${base}-search`}
      triggerLabel={triggerLabel(dd.selected, value)}
      badge={{ text: SENSE_DISPLAY[value.sense], testID: `${base}-sense-badge` }}
      placeholder="Search things to notice…"
      searchAccessibilityLabel="Search things to notice"
      open={dd.open}
      query={dd.query}
      onToggle={dd.toggle}
      onQueryChange={dd.setQuery}
      createSlot={
        dd.query.trim() !== '' ? (
          <CreateRow
            base={base}
            query={dd.query.trim()}
            createSense={dd.createSense}
            onPickSense={dd.setCreateSense}
            onCreate={dd.createCustom}
          />
        ) : undefined
      }
    >
      <GroupedOptions base={base} results={dd.results} onPick={dd.pickOption} />
    </SearchableDropdown>
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
    // Re-anchor the create-row sense to the prompt's current sense so a
    // reopen never shows a stale pick from an abandoned create attempt.
    setCreateSense(value.sense);
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
  const trimmed = value.label.trim();
  return trimmed !== '' ? trimmed : 'Choose what to notice';
}

interface CreateRowProps {
  base: string;
  query: string;
  createSense: SenseKind;
  onPickSense: (sense: SenseKind) => void;
  onCreate: () => void;
}

const CreateRow = ({
  base,
  query,
  createSense,
  onPickSense,
  onCreate,
}: CreateRowProps): React.JSX.Element => (
  <View style={dropdownCreateStyles.section} testID={`${base}-create-section`}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Use ${query} as a custom thing to notice`}
      onPress={onCreate}
      style={dropdownCreateStyles.row}
      testID={`${base}-create`}
    >
      <Text style={dropdownCreateStyles.rowText} numberOfLines={1}>
        {`+ Use “${query}”`}
      </Text>
    </TouchableOpacity>
    <View style={dropdownCreateStyles.controls}>
      <Text style={dropdownCreateStyles.controlsLabel}>Sense</Text>
      {ALLOWED_SENSES.map((sense) => (
        <Chip
          key={sense}
          label={SENSE_DISPLAY[sense]}
          active={createSense === sense}
          onPress={() => onPickSense(sense)}
          testID={`${base}-create-sense-${sense}`}
        />
      ))}
    </View>
  </View>
);

interface GroupedOptionsProps {
  base: string;
  results: readonly GroundingOption[];
  onPick: (opt: GroundingOption) => void;
}

const GroupedOptions = ({ base, results, onPick }: GroupedOptionsProps): React.JSX.Element => {
  if (results.length === 0) {
    return (
      <DropdownEmptyState label="No matches — create your own above." testID={`${base}-empty`} />
    );
  }
  return (
    <>
      {GROUNDING_GROUPS.map((group) => {
        const inGroup = results.filter((opt) => opt.group === group);
        if (inGroup.length === 0) return null;
        return (
          <View key={group} testID={`${base}-group-${group}`}>
            <DropdownGroupHeader label={group} />
            {inGroup.map((opt) => (
              <DropdownOptionRow
                key={opt.id}
                label={opt.label}
                caption={opt.prompt}
                onPress={() => onPick(opt)}
                testID={`${base}-option-${opt.id}`}
                accessibilityLabel={`${opt.label}, noticed through ${SENSE_DISPLAY[opt.sense]}`}
              />
            ))}
          </View>
        );
      })}
    </>
  );
};

export default GroundingDropdown;
