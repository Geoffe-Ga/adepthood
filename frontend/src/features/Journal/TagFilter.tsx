import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

import type { JournalTag } from '../../api';

import styles from './Journal.styles';

interface TagChip {
  label: string;
  value: JournalTag | null;
}

const TAG_CHIPS: TagChip[] = [
  { label: 'All', value: null },
  { label: 'Freeform', value: 'freeform' },
  { label: 'Reflections', value: 'stage_reflection' },
  { label: 'Practice Notes', value: 'practice_note' },
  { label: 'Habit Notes', value: 'habit_note' },
];

interface TagFilterProps {
  activeTag: JournalTag | null;
  onSelectTag: (_tag: JournalTag | null) => void;
}

const TagFilter = ({ activeTag, onSelectTag }: TagFilterProps): React.JSX.Element => {
  return (
    <View style={styles.tagFilterContainer}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {TAG_CHIPS.map((chip) => {
          const isActive = chip.value === activeTag;
          const testId = `tag-chip-${chip.value ?? 'all'}`;

          const handlePress = () => {
            if (chip.value === null) {
              onSelectTag(null);
            } else {
              onSelectTag(isActive ? null : chip.value);
            }
          };

          return (
            <TouchableOpacity
              key={testId}
              testID={testId}
              style={[styles.filterChip, isActive && styles.filterChipActive]}
              onPress={handlePress}
              accessibilityLabel={`Filter by ${chip.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                {chip.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

export default TagFilter;
