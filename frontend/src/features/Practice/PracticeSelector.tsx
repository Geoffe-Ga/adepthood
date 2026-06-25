import type { ReactElement } from 'react';
import React, { useCallback } from 'react';
import type { ListRenderItem } from 'react-native';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { PracticeItem } from '@/api';
import { colors, SPACING, BORDER_RADIUS, shadows } from '@/design/tokens';

interface PracticeSelectorProps {
  practices: PracticeItem[];
  selectedPracticeId: number | null;
  onSelect: (_id: number) => void;
  isLoading: boolean;
  isLocked?: boolean;
  /** Rendered above the built-in heading when the selector owns the scroll. */
  ListHeaderComponent?: ReactElement | null;
  /** Rendered below the windowed list (e.g. the weekly-progress bar). */
  ListFooterComponent?: ReactElement | null;
}

interface PracticeCardProps {
  practice: PracticeItem;
  isSelected: boolean;
  onSelect: (_id: number) => void;
}

const PracticeCardComponent = ({
  practice,
  isSelected,
  onSelect,
}: PracticeCardProps): React.JSX.Element => (
  <View
    style={[styles.card, isSelected && styles.cardSelected]}
    testID={`practice-card-${practice.id}`}
  >
    <View style={styles.cardHeader}>
      <Text style={styles.practiceName}>{practice.name}</Text>
      {isSelected && (
        <Text style={styles.checkmark} testID="selected-checkmark">
          ✓
        </Text>
      )}
    </View>
    <Text style={styles.description}>{practice.description}</Text>
    <Text style={styles.duration}>{practice.default_duration_minutes} min per session</Text>
    {!isSelected && (
      <TouchableOpacity
        style={styles.selectButton}
        onPress={() => onSelect(practice.id)}
        testID={`select-practice-${practice.id}`}
      >
        <Text style={styles.selectButtonText}>Select</Text>
      </TouchableOpacity>
    )}
  </View>
);

// Memoized so windowed rows don't re-render when an unrelated row's selection
// changes — only the (de)selected rows see a new ``isSelected``.
const PracticeCard = React.memo(PracticeCardComponent);

const keyExtractor = (practice: PracticeItem): string => String(practice.id);

type PracticeListProps = Pick<
  PracticeSelectorProps,
  'practices' | 'selectedPracticeId' | 'onSelect' | 'ListHeaderComponent' | 'ListFooterComponent'
>;

const PracticeList = ({
  practices,
  selectedPracticeId,
  onSelect,
  ListHeaderComponent,
  ListFooterComponent,
}: PracticeListProps): React.JSX.Element => {
  const renderItem = useCallback<ListRenderItem<PracticeItem>>(
    ({ item }) => (
      <PracticeCard
        practice={item}
        isSelected={item.id === selectedPracticeId}
        onSelect={onSelect}
      />
    ),
    [selectedPracticeId, onSelect],
  );

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.container}
      data={practices}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={
        <View>
          {ListHeaderComponent}
          <Text style={styles.heading}>Choose a Practice</Text>
        </View>
      }
      ListFooterComponent={ListFooterComponent}
      testID="practice-selector"
    />
  );
};

const PracticeSelector: React.FC<PracticeSelectorProps> = ({
  practices,
  selectedPracticeId,
  onSelect,
  isLoading,
  isLocked = false,
  ListHeaderComponent,
  ListFooterComponent,
}) => {
  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="selector-loading">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isLocked) {
    return (
      <View style={styles.emptyContainer} testID="selector-locked">
        <Text style={styles.emptyText}>
          This stage is locked. Complete earlier stages to unlock practices here.
        </Text>
      </View>
    );
  }

  if (practices.length === 0) {
    return (
      <View style={styles.emptyContainer} testID="selector-empty">
        <Text style={styles.emptyText}>No practices available for this stage yet.</Text>
      </View>
    );
  }

  return (
    <PracticeList
      practices={practices}
      selectedPracticeId={selectedPracticeId}
      onSelect={onSelect}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={ListFooterComponent}
    />
  );
};

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  container: {
    padding: SPACING.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xxl,
  },
  emptyContainer: {
    padding: SPACING.xxl,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 16,
    textAlign: 'center',
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: SPACING.lg,
  },
  card: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...shadows.small,
  },
  cardSelected: {
    borderWidth: 2,
    borderColor: colors.success,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  practiceName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text.primary,
    flex: 1,
  },
  checkmark: {
    fontSize: 20,
    color: colors.success,
    fontWeight: '700',
  },
  description: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.sm,
    lineHeight: 20,
  },
  duration: {
    fontSize: 13,
    color: colors.text.tertiary,
    marginBottom: SPACING.md,
  },
  selectButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  selectButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: 15,
  },
});

export default PracticeSelector;
