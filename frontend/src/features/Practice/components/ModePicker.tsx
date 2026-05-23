/**
 * ``ModePicker`` — categorized chooser for the Create Practice wizard.
 *
 * 11 practice modes is bloat as a flat list, so the picker groups them
 * into five intent-oriented categories (Timers / Bells / Grounding /
 * Reflection / Movement). Each row is radio-like so the screen reader
 * announces selection state correctly.
 *
 * Pure data → UI: ``onSelect`` is the only output. The wizard owns the
 * choice and routes to the matching mode form on selection.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { ModeConfig } from '../engine/types';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/**
 * Discriminator union for every mode shown in the picker. ``mindful_anchor``
 * has no frontend type yet (the runtime engine + form land in a follow-up),
 * so it is added inline here so the picker still surfaces it under
 * Grounding — selecting it routes to a "Coming soon" notice in the wizard.
 */
export type PickableMode = ModeConfig['mode'] | 'mindful_anchor';

const NEW_MODES = new Set<PickableMode>([
  'tallied_grounding',
  'mindful_anchor',
  'random_interval_bell',
  'card_meditation',
]);

interface ModeEntry {
  mode: PickableMode;
  label: string;
  icon: string;
  description: string;
}

interface ModeCategory {
  key: string;
  title: string;
  blurb: string;
  modes: readonly ModeEntry[];
}

export const MODE_CATEGORIES: readonly ModeCategory[] = [
  {
    key: 'timers',
    title: 'Timers',
    blurb: 'Bounded or open-ended sits.',
    modes: [
      {
        mode: 'meditation_timer',
        label: 'Meditation timer',
        icon: '⏳',
        description: 'A bounded sit with optional bells.',
      },
      {
        mode: 'count_up',
        label: 'Count up',
        icon: '⏱',
        description: 'Open-ended; you decide when to stop.',
      },
    ],
  },
  {
    key: 'bells',
    title: 'Bells',
    blurb: 'Rhythmic cues across the session.',
    modes: [
      {
        mode: 'metronome',
        label: 'Metronome',
        icon: '🥁',
        description: 'Steady BPM tick over a timed window.',
      },
      {
        mode: 'interval_bell',
        label: 'Interval bell',
        icon: '🔔',
        description: 'Evenly spaced bells or custom offsets.',
      },
      {
        mode: 'random_interval_bell',
        label: 'Random interval bell',
        icon: '🔀',
        description: 'Mindfulness bells at unpredictable gaps.',
      },
    ],
  },
  {
    key: 'grounding',
    title: 'Grounding',
    blurb: 'Bring attention back into the body.',
    modes: [
      {
        mode: 'sense_grounding',
        label: 'Sense grounding',
        icon: '🌿',
        description: 'Walk through prompts across the five senses.',
      },
      {
        mode: 'tallied_grounding',
        label: 'Tallied grounding',
        icon: '🔢',
        description: 'Rounds of find-N-of-each: shapes, colors, sounds.',
      },
      {
        mode: 'mindful_anchor',
        label: 'Mindful anchor',
        icon: '🌱',
        description: 'Pick one anchor — touch grass, mindful eating, a sip.',
      },
    ],
  },
  {
    key: 'reflection',
    title: 'Reflection',
    blurb: 'Symbol-driven contemplation.',
    modes: [
      {
        mode: 'tarot',
        label: 'Tarot',
        icon: '🃏',
        description: 'Draw a card from the major arcana and sit with it.',
      },
      {
        mode: 'card_meditation',
        label: 'Card meditation',
        icon: '🎴',
        description: 'Bundled or custom deck — phone photos work.',
      },
    ],
  },
  {
    key: 'movement',
    title: 'Movement',
    blurb: 'Count discrete reps or rounds.',
    modes: [
      {
        mode: 'rep_counter',
        label: 'Rep counter',
        icon: '💪',
        description: 'Tap to log each rep against a target.',
      },
    ],
  },
];

export interface ModePickerProps {
  /** Currently focused mode; rendered as the selected radio. */
  selectedMode?: PickableMode | null;
  /** Called when a mode is tapped. The wizard advances on the next render. */
  onSelect: (mode: PickableMode) => void;
}

/**
 * Render the five mode categories as cards. Each mode row is a radio
 * button — TalkBack/VoiceOver announce ``selected`` correctly so users
 * relying on screen readers can navigate the categorized list.
 */
const ModePicker = ({ selectedMode = null, onSelect }: ModePickerProps): React.JSX.Element => (
  <View
    accessibilityRole="radiogroup"
    accessibilityLabel="Choose a practice mode"
    testID="mode-picker"
  >
    {MODE_CATEGORIES.map((category) => (
      <CategoryCard
        key={category.key}
        category={category}
        selectedMode={selectedMode}
        onSelect={onSelect}
      />
    ))}
  </View>
);

interface CategoryCardProps {
  category: ModeCategory;
  selectedMode: PickableMode | null;
  onSelect: (mode: PickableMode) => void;
}

const CategoryCard = ({
  category,
  selectedMode,
  onSelect,
}: CategoryCardProps): React.JSX.Element => (
  <View style={styles.card} testID={`mode-picker-category-${category.key}`}>
    <Text style={styles.categoryTitle}>{category.title}</Text>
    <Text style={styles.categoryBlurb}>{category.blurb}</Text>
    {category.modes.map((entry) => (
      <ModeRow
        key={entry.mode}
        entry={entry}
        selected={entry.mode === selectedMode}
        onSelect={onSelect}
      />
    ))}
  </View>
);

interface ModeRowProps {
  entry: ModeEntry;
  selected: boolean;
  onSelect: (mode: PickableMode) => void;
}

const ModeRow = ({ entry, selected, onSelect }: ModeRowProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="radio"
    accessibilityLabel={entry.label}
    accessibilityHint={entry.description}
    accessibilityState={{ selected }}
    onPress={() => onSelect(entry.mode)}
    style={[styles.row, selected && styles.rowSelected]}
    testID={`mode-picker-mode-${entry.mode}`}
  >
    <Text style={styles.rowIcon} accessibilityElementsHidden>
      {entry.icon}
    </Text>
    <View style={styles.rowText}>
      <View style={styles.rowLabelLine}>
        <Text style={styles.rowLabel}>{entry.label}</Text>
        {NEW_MODES.has(entry.mode) && (
          <View style={styles.newBadge} testID={`mode-picker-new-${entry.mode}`}>
            <Text style={styles.newBadgeText}>New</Text>
          </View>
        )}
      </View>
      <Text style={styles.rowDescription}>{entry.description}</Text>
    </View>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  categoryTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  categoryBlurb: {
    fontSize: 13,
    color: colors.text.secondaryAccessible,
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    gap: SPACING.sm,
  },
  rowSelected: { backgroundColor: colors.background.accent },
  rowIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  rowText: { flex: 1 },
  rowLabelLine: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  rowLabel: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
  rowDescription: {
    fontSize: 12,
    color: colors.text.secondaryAccessible,
    marginTop: 2,
  },
  newBadge: {
    backgroundColor: colors.success,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.sm,
  },
  newBadgeText: { color: colors.text.light, fontSize: 10, fontWeight: '700' },
});

export default ModePicker;
