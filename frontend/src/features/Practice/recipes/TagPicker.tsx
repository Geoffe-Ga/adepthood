import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { nameToSlug } from './types';

import type { PracticeTag, PracticeTagCreate } from '@/api';
import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

export interface TagPickerProps {
  stepIndex: number;
  selectedSlug: string;
  tagLibrary: PracticeTag[];
  onSelect: (tag: PracticeTag) => void;
  /** Resolves once the tag is persisted; the caller usually patches
   *  the step's tag_slug + tag_label inside this callback. */
  onCreateTag: (payload: PracticeTagCreate) => Promise<void>;
}

/**
 * Two-state widget under a recipe step's tag chip row.
 *
 * Default state: render every tag in ``tagLibrary`` as a selectable
 * chip plus a "+ New tag" affordance.  When the user taps "+ New tag"
 * the inline create form takes over with two inputs (label + slug)
 * and a Create button that mints a fresh tag and selects it.
 *
 * Slug auto-fills from the label via ``nameToSlug`` so the user
 * never has to think about snake-casing -- they only see it if they
 * want to override the derived value.
 */
const TagPicker = (props: TagPickerProps): React.JSX.Element => {
  const [creating, setCreating] = useState(false);
  const sortedTags = useMemo(() => sortTagsForPicker(props.tagLibrary), [props.tagLibrary]);
  return (
    <View style={styles.container} testID={`tag-picker-${props.stepIndex}`}>
      <View style={styles.chipRow}>
        {sortedTags.map((tag) => (
          <TagChip
            key={`${tag.owner_user_id ?? 'sys'}-${tag.id}`}
            tag={tag}
            active={tag.slug === props.selectedSlug}
            onPress={() => props.onSelect(tag)}
            testID={`tag-picker-${props.stepIndex}-chip-${tag.slug}`}
          />
        ))}
        {!creating && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Create new tag"
            onPress={() => setCreating(true)}
            style={[styles.chip, styles.newTagChip]}
            testID={`tag-picker-${props.stepIndex}-new`}
          >
            <Text style={styles.newTagText}>+ New tag</Text>
          </TouchableOpacity>
        )}
      </View>
      {creating && (
        <InlineTagCreator
          stepIndex={props.stepIndex}
          onCreate={async (payload) => {
            await props.onCreateTag(payload);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </View>
  );
};

interface TagChipProps {
  tag: PracticeTag;
  active: boolean;
  onPress: () => void;
  testID: string;
}

const TagChip = ({ tag, active, onPress, testID }: TagChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={tag.label}
    accessibilityState={{ selected: active }}
    onPress={onPress}
    style={[styles.chip, active && styles.chipActive]}
    testID={testID}
  >
    <Text style={[styles.chipText, active && styles.chipTextActive]}>{tag.label}</Text>
  </TouchableOpacity>
);

interface InlineTagCreatorProps {
  stepIndex: number;
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
  onCreate: (payload: PracticeTagCreate) => Promise<void>,
): CreatorFormState {
  const [label, setLabel] = useState('');
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
  const form = useCreatorFormState(props.onCreate);
  return (
    <View style={styles.creator} testID={`tag-picker-${props.stepIndex}-creator`}>
      <TextInput
        value={form.label}
        onChangeText={form.setLabel}
        style={styles.input}
        placeholder="Tag label (what users see)"
        maxLength={255}
        testID={`tag-picker-${props.stepIndex}-creator-label`}
      />
      <TextInput
        value={form.slug.length > 0 ? form.slug : form.derivedSlug}
        onChangeText={form.setSlug}
        style={styles.input}
        placeholder="slug_in_snake_case"
        maxLength={64}
        autoCapitalize="none"
        autoCorrect={false}
        testID={`tag-picker-${props.stepIndex}-creator-slug`}
      />
      {form.error !== null && (
        <Text style={styles.error} testID={`tag-picker-${props.stepIndex}-creator-error`}>
          {form.error}
        </Text>
      )}
      <CreatorActions
        stepIndex={props.stepIndex}
        canCreate={form.canCreate}
        onCancel={props.onCancel}
        onConfirm={form.submit}
      />
    </View>
  );
};

interface CreatorActionsProps {
  stepIndex: number;
  canCreate: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const CreatorActions = (props: CreatorActionsProps): React.JSX.Element => (
  <View style={styles.creatorActions}>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Cancel new tag"
      onPress={props.onCancel}
      style={[styles.chip, styles.cancelChip]}
      testID={`tag-picker-${props.stepIndex}-creator-cancel`}
    >
      <Text style={styles.chipText}>Cancel</Text>
    </TouchableOpacity>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Create tag"
      accessibilityState={{ disabled: !props.canCreate }}
      onPress={props.canCreate ? props.onConfirm : undefined}
      style={[styles.chip, styles.confirmChip, !props.canCreate && styles.disabled]}
      testID={`tag-picker-${props.stepIndex}-creator-confirm`}
    >
      <Text style={styles.confirmText}>Create</Text>
    </TouchableOpacity>
  </View>
);

function sortTagsForPicker(tags: PracticeTag[]): PracticeTag[] {
  // System tags first, then personal, alphabetised within each group so
  // the chip row stays predictable as the library grows.
  return [...tags].sort((a, b) => {
    const aSys = a.owner_user_id === null ? 0 : 1;
    const bSys = b.owner_user_id === null ? 0 : 1;
    if (aSys !== bSys) return aSys - bSys;
    return a.label.localeCompare(b.label);
  });
}

const styles = StyleSheet.create({
  container: { gap: SPACING.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: 1,
    borderColor: colors.background.accent,
    backgroundColor: colors.background.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text.secondaryAccessible, fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: colors.text.light },
  newTagChip: { borderStyle: 'dashed' },
  newTagText: { color: colors.text.primary, fontSize: 13, fontWeight: '500' },
  creator: {
    marginTop: SPACING.xs,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.background.accent,
    gap: SPACING.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.background.card,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    color: colors.text.primary,
    fontSize: 13,
    backgroundColor: colors.background.primary,
  },
  creatorActions: { flexDirection: 'row', gap: SPACING.xs, justifyContent: 'flex-end' },
  cancelChip: { backgroundColor: colors.background.card },
  confirmChip: { backgroundColor: colors.primary, borderColor: colors.primary },
  confirmText: { color: colors.text.light, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  error: { color: colors.danger, fontSize: 12 },
});

export default TagPicker;
