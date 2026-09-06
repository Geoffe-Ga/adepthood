/**
 * A quiet, display-only reading of the compiled pages this entry touched in
 * the writer's Creek vault. It lives beside the journal page, not in its
 * margin: praxis and eddies describe corpus-level patterns rather than a span
 * of the current entry.
 */
import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import type { RelatedEddy, RelatedPraxis, RelatedPraxisStatus } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  contentLayout,
  editorialType,
  ink,
  journalSheet,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

export interface FromYourCreekPanelProps {
  praxis: RelatedPraxis[];
  eddies: RelatedEddy[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Keep enough of the journal page visible to make collapse an obvious choice. */
const MAX_EXPANDED_VIEWPORT_RATIO = 0.6;

/** The vault's lifecycle language, softened where an internal status is terse. */
function statusLabel(status: RelatedPraxisStatus): string {
  return status === 'released' ? 'set down' : status;
}

/** Read a contract date without timezone conversion moving it into another month. */
function formedMonth(formed: string): string | null {
  const match = /^\d{4}-(\d{2})-\d{2}/.exec(formed);
  if (match == null) return null;
  const monthIndex = Number(match[1]) - 1;
  return MONTHS[monthIndex] ?? null;
}

function eddyCaption(eddy: RelatedEddy): string {
  const noun = eddy.fragment_count === 1 ? 'fragment' : 'fragments';
  const month = formedMonth(eddy.formed);
  return `${eddy.fragment_count} ${noun}${month == null ? '' : ` since ${month}`}`;
}

/** Join screen-reader phrases without doubling punctuation from vault prose. */
function sentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function PraxisPages({ items }: { items: RelatedPraxis[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <View style={styles.section} testID="from-your-creek-praxis">
      <Text style={styles.sectionHeading}>Praxis</Text>
      {items.map((item, index) => (
        <View
          key={`${item.title}-${index}`}
          style={styles.page}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${item.title}. ${item.praxis_type}, ${statusLabel(item.status)}. ${item.excerpt}`}
        >
          <Text style={styles.pageTitle}>{item.title}</Text>
          <Text style={styles.caption}>
            {item.praxis_type} · {statusLabel(item.status)}
          </Text>
          <Text style={styles.prose}>{item.excerpt}</Text>
        </View>
      ))}
    </View>
  );
}

function EddyPages({ items }: { items: RelatedEddy[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <View style={styles.section} testID="from-your-creek-eddies">
      <Text style={styles.sectionHeading}>Eddies</Text>
      {items.map((item, index) => {
        const caption = eddyCaption(item);
        const accessibilityLabel = [item.title, item.description, caption]
          .map(sentence)
          .filter(Boolean)
          .join(' ');
        return (
          <View
            key={`${item.title}-${index}`}
            style={styles.page}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={accessibilityLabel}
          >
            <Text style={styles.pageTitle}>{item.title}</Text>
            {item.description.length === 0 ? null : (
              <Text style={styles.prose}>{item.description}</Text>
            )}
            <Text style={styles.caption}>{caption}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Collapsed by default, following the sources panel's invitation-to-expand. */
function FromYourCreekPanel({ praxis, eddies }: FromYourCreekPanelProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const { height } = useWindowDimensions();
  const pageCount = praxis.length + eddies.length;
  if (pageCount === 0) return null;

  return (
    <View style={styles.band}>
      <View style={styles.panel} testID="from-your-creek">
        <TouchableOpacity
          style={styles.toggle}
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} related pages from your creek`}
          testID="from-your-creek-toggle"
        >
          <Text style={styles.toggleTitle} testID="from-your-creek-title">
            From your creek
          </Text>
          <Text style={styles.toggleCount}>
            {pageCount} {pageCount === 1 ? 'page' : 'pages'}
          </Text>
        </TouchableOpacity>
        {expanded ? (
          <ScrollView
            style={[styles.body, { maxHeight: height * MAX_EXPANDED_VIEWPORT_RATIO }]}
            contentContainerStyle={styles.bodyContent}
            nestedScrollEnabled
            testID="from-your-creek-body"
          >
            <PraxisPages items={praxis} />
            <EddyPages items={eddies} />
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    width: '100%',
    maxWidth: contentLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: journalSheet.deskPaddingH,
    paddingTop: SPACING.sm,
  },
  panel: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: surface.hairline,
    ...surfaceShadow.card,
  },
  toggle: {
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
  },
  toggleTitle: {
    ...editorialType.action,
    color: ink.primary,
    flex: 1,
  },
  toggleCount: {
    ...editorialType.action,
    color: accent.primary,
    flexShrink: 1,
    textAlign: 'right',
  },
  body: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: surface.hairline,
  },
  bodyContent: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
  },
  section: {
    marginBottom: SPACING.md,
  },
  sectionHeading: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
    marginBottom: SPACING.sm,
  },
  page: {
    backgroundColor: surface.sunken,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  pageTitle: {
    ...editorialType.note,
    color: ink.primary,
    fontWeight: '600',
  },
  caption: {
    ...editorialType.caption,
    color: ink.muted,
    paddingTop: SPACING.xs,
  },
  prose: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: SPACING.xs,
  },
});

export default FromYourCreekPanel;
