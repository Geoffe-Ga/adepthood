import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import * as copy from '../copy';
import type { FeedbackInboxState } from '../useFeedbackInbox';

import type { FeedbackStatusT, FeedbackTriageSummaryT } from '@/api';
import { Button } from '@/components/Button';
import {
  accent,
  ink,
  radius,
  rhythm,
  surface,
  touchTarget,
  type as typeRamp,
} from '@/design/tokens';

/** The status filters, in triage order. ``undefined`` is "all". */
const STATUS_FILTERS: readonly (FeedbackStatusT | undefined)[] = [
  undefined,
  'new',
  'triaged',
  'planned',
  'closed',
];

interface FilterChipProps {
  status: FeedbackStatusT | undefined;
  active: boolean;
  onPress: () => void;
}

function FilterChip({ status, active, onPress }: FilterChipProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const label = status ?? copy.FILTER_ALL;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Show ${label} reports`}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      testID={`inbox-filter-${status ?? 'all'}`}
    >
      <Text style={[t.label, active ? styles.chipTextActive : styles.chipText]}>{label}</Text>
    </Pressable>
  );
}

interface RowProps {
  item: FeedbackTriageSummaryT;
  selected: boolean;
  onSelect: (_publicId: string) => void;
}

function InboxRow({ item, selected, onSelect }: RowProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${item.public_id}, ${item.category}, ${item.impact}, ${item.status}, on ${item.screen}`}
      onPress={() => onSelect(item.public_id)}
      style={[styles.row, selected && styles.rowSelected]}
      testID={`inbox-row-${item.public_id}`}
    >
      <Text style={[t.label, styles.rowTitle]}>{item.public_id}</Text>
      <Text style={[t.caption, styles.rowMeta]}>
        {`${item.status} · ${item.category} · ${item.impact} · ${item.screen} · ${item.app_build}`}
      </Text>
    </Pressable>
  );
}

interface InboxListProps {
  inbox: FeedbackInboxState;
  selectedId: string | null;
  onSelect: (_publicId: string) => void;
}

/** The filtered, paged inbox. Rows carry no prose: reading one means opening it. */
export function InboxList({ inbox, selectedId, onSelect }: InboxListProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View testID="inbox-list">
      <View style={styles.filters}>
        {STATUS_FILTERS.map((status) => (
          <FilterChip
            key={status ?? 'all'}
            status={status}
            active={inbox.status === status}
            onPress={() => inbox.setStatus(status)}
          />
        ))}
      </View>
      {inbox.items.map((item) => (
        <InboxRow
          key={item.public_id}
          item={item}
          selected={item.public_id === selectedId}
          onSelect={onSelect}
        />
      ))}
      {!inbox.loading && !inbox.failed && inbox.items.length === 0 ? (
        <Text style={[t.body, styles.empty]}>{copy.EMPTY_INBOX}</Text>
      ) : null}
      {inbox.failed ? (
        <View>
          <Text style={[t.body, styles.empty]}>{copy.LOAD_FAILED}</Text>
          <Button
            label={copy.RETRY}
            variant="secondary"
            onPress={inbox.reload}
            testID="inbox-retry"
          />
        </View>
      ) : null}
      {inbox.hasMore ? (
        <Button
          label={copy.LOAD_MORE}
          variant="secondary"
          busy={inbox.loading}
          onPress={inbox.loadMore}
          testID="inbox-load-more"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: rhythm.blockGap,
    marginBottom: rhythm.blockGap,
  },
  chip: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: rhythm.blockGap,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  chipActive: {
    backgroundColor: accent.primary,
    borderColor: accent.primary,
  },
  chipText: {
    color: ink.primary,
  },
  chipTextActive: {
    color: accent.onPrimary,
  },
  row: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingVertical: rhythm.blockGap,
    paddingHorizontal: rhythm.blockGap,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: surface.hairline,
  },
  rowSelected: {
    backgroundColor: surface.sunken,
  },
  rowTitle: {
    color: ink.primary,
  },
  rowMeta: {
    color: ink.soft,
  },
  empty: {
    color: ink.soft,
    marginVertical: rhythm.blockGap,
  },
});
