import React, { useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import SearchableDropdown, {
  DropdownEmptyState,
  DropdownGroupHeader,
  DropdownOptionRow,
  dropdownCreateStyles,
} from '../components/SearchableDropdown';

import { nameToSlug } from './types';

import type { PracticeTag, PracticeTagCreate } from '@/api';

export interface TagPickerProps {
  stepIndex: number;
  selectedSlug: string;
  tagLibrary: PracticeTag[];
  onSelect: (tag: PracticeTag) => void;
  /** Resolves once the tag is persisted; the caller usually patches
   *  the step's tag_slug + tag_label inside this callback. */
  onCreateTag: (payload: PracticeTagCreate) => Promise<void>;
}

const LABEL_MAX = 255;
const SLUG_MAX = 64;

/**
 * Searchable dropdown over a recipe step's tag library.
 *
 * Mirrors the configurator's grounding dropdown for a consistent feel:
 * a collapsed trigger showing the chosen tag, then a search box, the
 * library split into "Library" (system) and "Yours" (personal) sections,
 * and an inline "create your own" tag form. Slug auto-fills from the
 * label via {@link nameToSlug} so the user only sees it to override it.
 */
const TagPicker = (props: TagPickerProps): React.JSX.Element => {
  const base = `tag-picker-${props.stepIndex}`;
  const dd = useTagDropdown(props);
  return (
    <SearchableDropdown
      testID={base}
      triggerTestID={`${base}-trigger`}
      panelTestID={`${base}-panel`}
      searchTestID={`${base}-search`}
      triggerLabel={dd.triggerLabel}
      badge={dd.badge}
      placeholder="Search tags…"
      open={dd.open}
      query={dd.query}
      onToggle={dd.toggle}
      onQueryChange={dd.setQuery}
      createSlot={
        dd.creating ? (
          <InlineTagCreator
            base={base}
            initialLabel={dd.query.trim()}
            onCreate={dd.create}
            onCancel={() => dd.setCreating(false)}
          />
        ) : (
          <NewTagButton base={base} onPress={() => dd.setCreating(true)} />
        )
      }
    >
      <TagOptions
        base={base}
        groups={dd.groups}
        selectedSlug={props.selectedSlug}
        onSelect={dd.select}
      />
    </SearchableDropdown>
  );
};

interface TagGroup {
  key: string;
  label: string;
  tags: PracticeTag[];
}

interface TagDropdownController {
  open: boolean;
  query: string;
  creating: boolean;
  groups: TagGroup[];
  triggerLabel: string;
  badge: { text: string; testID: string } | undefined;
  toggle: () => void;
  setQuery: (next: string) => void;
  setCreating: (next: boolean) => void;
  select: (tag: PracticeTag) => void;
  create: (payload: PracticeTagCreate) => Promise<void>;
}

function useTagDropdown(props: TagPickerProps): TagDropdownController {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const groups = useMemo(() => groupTags(props.tagLibrary, query), [props.tagLibrary, query]);
  const selected = props.tagLibrary.find((tag) => tag.slug === props.selectedSlug);
  const reset = (): void => {
    setOpen(false);
    setQuery('');
    setCreating(false);
  };
  return {
    open,
    query,
    creating,
    groups,
    triggerLabel: triggerLabelFor(selected, props.selectedSlug),
    badge:
      selected === undefined
        ? undefined
        : {
            text: selected.owner_user_id === null ? 'System' : 'Custom',
            testID: `tag-picker-${props.stepIndex}-badge`,
          },
    toggle: () => setOpen((prev) => !prev),
    setQuery,
    setCreating,
    select: (tag) => {
      props.onSelect(tag);
      reset();
    },
    create: async (payload) => {
      await props.onCreateTag(payload);
      reset();
    },
  };
}

function triggerLabelFor(selected: PracticeTag | undefined, selectedSlug: string): string {
  if (selected !== undefined) return selected.label;
  if (selectedSlug.length > 0) return selectedSlug;
  return 'Choose a tag';
}

/** Split the library into system + personal sections, filtered + alphabetised. */
function groupTags(tagLibrary: PracticeTag[], query: string): TagGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = (tag: PracticeTag): boolean =>
    needle === '' ||
    tag.label.toLowerCase().includes(needle) ||
    tag.slug.toLowerCase().includes(needle);
  const byLabel = (a: PracticeTag, b: PracticeTag): number => a.label.localeCompare(b.label);
  const system = tagLibrary.filter((t) => t.owner_user_id === null && matches(t)).sort(byLabel);
  const personal = tagLibrary.filter((t) => t.owner_user_id !== null && matches(t)).sort(byLabel);
  return [
    { key: 'library', label: 'Library', tags: system },
    { key: 'yours', label: 'Yours', tags: personal },
  ].filter((group) => group.tags.length > 0);
}

interface TagOptionsProps {
  base: string;
  groups: TagGroup[];
  selectedSlug: string;
  onSelect: (tag: PracticeTag) => void;
}

const TagOptions = ({
  base,
  groups,
  selectedSlug,
  onSelect,
}: TagOptionsProps): React.JSX.Element => {
  if (groups.length === 0) {
    return (
      <DropdownEmptyState label="No tags match — create one below." testID={`${base}-empty`} />
    );
  }
  return (
    <>
      {groups.map((group) => (
        <View key={group.key} testID={`${base}-group-${group.key}`}>
          <DropdownGroupHeader label={group.label} />
          {group.tags.map((tag) => (
            <DropdownOptionRow
              key={`${tag.owner_user_id ?? 'sys'}-${tag.id}`}
              label={tag.label}
              onPress={() => onSelect(tag)}
              selected={tag.slug === selectedSlug}
              testID={`${base}-option-${tag.slug}`}
              accessibilityLabel={tag.label}
            />
          ))}
        </View>
      ))}
    </>
  );
};

const NewTagButton = ({
  base,
  onPress,
}: {
  base: string;
  onPress: () => void;
}): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel="Create new tag"
    onPress={onPress}
    style={dropdownCreateStyles.row}
    testID={`${base}-new`}
  >
    <Text style={dropdownCreateStyles.rowText}>+ New tag</Text>
  </TouchableOpacity>
);

interface InlineTagCreatorProps {
  base: string;
  initialLabel: string;
  onCreate: (payload: PracticeTagCreate) => Promise<void>;
  onCancel: () => void;
}

interface CreatorFormState {
  label: string;
  setLabel: (next: string) => void;
  slug: string;
  setSlug: (next: string) => void;
  error: string | null;
  busy: boolean;
  derivedSlug: string;
  canCreate: boolean;
  submit: () => Promise<void>;
}

function useCreatorFormState(
  initialLabel: string,
  onCreate: (payload: PracticeTagCreate) => Promise<void>,
): CreatorFormState {
  const [label, setLabel] = useState(initialLabel);
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const derivedSlug = slug.length > 0 ? slug : nameToSlug(label);
  const canCreate = label.trim().length > 0 && derivedSlug.length > 0 && !busy;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({ slug: derivedSlug, label: label.trim() });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create tag.');
    } finally {
      setBusy(false);
    }
  };
  return { label, setLabel, slug, setSlug, error, busy, derivedSlug, canCreate, submit };
}

const InlineTagCreator = (props: InlineTagCreatorProps): React.JSX.Element => {
  const form = useCreatorFormState(props.initialLabel, props.onCreate);
  return (
    <View style={dropdownCreateStyles.section} testID={`${props.base}-creator`}>
      <TextInput
        value={form.label}
        onChangeText={form.setLabel}
        style={dropdownCreateStyles.input}
        placeholder="Tag label (what users see)"
        maxLength={LABEL_MAX}
        testID={`${props.base}-creator-label`}
      />
      <TextInput
        value={form.slug.length > 0 ? form.slug : form.derivedSlug}
        onChangeText={form.setSlug}
        style={dropdownCreateStyles.input}
        placeholder="slug_in_snake_case"
        maxLength={SLUG_MAX}
        autoCapitalize="none"
        autoCorrect={false}
        testID={`${props.base}-creator-slug`}
      />
      {form.error !== null && (
        <Text style={dropdownCreateStyles.error} testID={`${props.base}-creator-error`}>
          {form.error}
        </Text>
      )}
      <CreatorActions
        base={props.base}
        canCreate={form.canCreate}
        onCancel={props.onCancel}
        onConfirm={form.submit}
      />
    </View>
  );
};

interface CreatorActionsProps {
  base: string;
  canCreate: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const CreatorActions = (props: CreatorActionsProps): React.JSX.Element => (
  <View style={dropdownCreateStyles.controls}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Cancel new tag"
      onPress={props.onCancel}
      style={dropdownCreateStyles.row}
      testID={`${props.base}-creator-cancel`}
    >
      <Text style={dropdownCreateStyles.controlsLabel}>Cancel</Text>
    </TouchableOpacity>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Create tag"
      accessibilityState={{ disabled: !props.canCreate }}
      onPress={props.canCreate ? props.onConfirm : undefined}
      style={dropdownCreateStyles.row}
      testID={`${props.base}-creator-confirm`}
    >
      <Text style={dropdownCreateStyles.rowText}>Create</Text>
    </TouchableOpacity>
  </View>
);

export default TagPicker;
