/**
 * The review a chosen folder waits in before anything is sent (#3555).
 *
 * It shows what would go and nothing more: the import's name (editable,
 * because re-importing under the same name updates rather than copies), how
 * many notes are selected and their size, the attachments as one switch that
 * starts off, what was left out by reason, and the paths themselves so two
 * `Index.md` files read as two. The privacy choice sits above it on the screen
 * and applies to everything sent, attachments included.
 *
 * Starting is refused, with the reason said, while nothing is selected, the
 * selection is past the size bound, or the name would be refused. It also
 * waits while files picked meanwhile are still going over, so the run never
 * has two send loops at once.
 */
import React from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  folderAttachmentsLabel,
  folderMoreLine,
  folderNotesLine,
  folderSelectedSizeLine,
  folderSkippedLine,
  SEED_FOLDER_DISMISS_LABEL,
  SEED_FOLDER_NAMESPACE_HINT,
  SEED_FOLDER_NAMESPACE_LABEL,
  SEED_FOLDER_REVIEW_TITLE,
  SEED_FOLDER_START_LABEL,
} from './seedFolderCopy';
import type { SeedFolderController, SeedFolderReview as Review } from './useSeedFolder';

import { EditorialSection } from '@/components/layout/EditorialSection';
import { accent, BORDER_RADIUS, ink, SPACING, surface, touchTarget } from '@/design/tokens';
import { SettingsSwitch } from '@/features/Settings/shared/SettingsSwitch';

/** How many paths the review lists before summing up the rest. */
export const SEED_FOLDER_PREVIEW_LIMIT = 50;

const NAMESPACE_FONT_SIZE = 16;

/** The editable import name and what it is for. */
const NamespaceField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (_value: string) => void;
}): React.JSX.Element => (
  <>
    <Text style={styles.label}>{SEED_FOLDER_NAMESPACE_LABEL}</Text>
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={onChange}
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel={SEED_FOLDER_NAMESPACE_LABEL}
      testID="seed-folder-namespace"
    />
    <Text style={styles.hint}>{SEED_FOLDER_NAMESPACE_HINT}</Text>
  </>
);

/** The one switch that adds every supported attachment; absent when there are none. */
const AttachmentsSwitch = ({
  count,
  value,
  onChange,
}: {
  count: number;
  value: boolean;
  onChange: (_value: boolean) => void;
}): React.JSX.Element | null => {
  if (count === 0) return null;
  const label = folderAttachmentsLabel(count);
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <SettingsSwitch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        testID="seed-folder-attachments"
      />
    </View>
  );
};

/** The selected paths, the first {@link SEED_FOLDER_PREVIEW_LIMIT} of them. */
const PathList = ({ review }: { review: Review }): React.JSX.Element => {
  const entries = review.selection.entries;
  const shown = entries.slice(0, SEED_FOLDER_PREVIEW_LIMIT);
  const more = folderMoreLine(entries.length - shown.length);
  return (
    <View style={styles.paths}>
      {shown.map((entry, index) => (
        <Text
          key={entry.relativePath}
          style={styles.path}
          numberOfLines={1}
          testID={`seed-folder-path-${index}`}
        >
          {entry.relativePath}
        </Text>
      ))}
      {more ? <Text style={styles.hint}>{more}</Text> : null}
    </View>
  );
};

/** Start and put aside, with start inert while something is in its way. */
const ReviewActions = ({
  blocked,
  onStart,
  onDismiss,
}: {
  blocked: boolean;
  onStart: () => void;
  onDismiss: () => void;
}): React.JSX.Element => (
  <View style={styles.actions}>
    <TouchableOpacity
      style={[styles.start, blocked ? styles.startDisabled : null]}
      onPress={onStart}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={SEED_FOLDER_START_LABEL}
      accessibilityState={{ disabled: blocked }}
      testID="seed-folder-start"
    >
      <Text style={styles.startText}>{SEED_FOLDER_START_LABEL}</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={styles.dismiss}
      onPress={onDismiss}
      accessibilityRole="button"
      accessibilityLabel={SEED_FOLDER_DISMISS_LABEL}
      testID="seed-folder-dismiss"
    >
      <Text style={styles.dismissText}>{SEED_FOLDER_DISMISS_LABEL}</Text>
    </TouchableOpacity>
  </View>
);

/** The review of a chosen folder, driven by the folder controller. */
export const SeedFolderReview = ({
  folder,
  review,
  isSending,
}: {
  folder: SeedFolderController;
  review: Review;
  /** Whether an earlier batch is still going over; one batch runs at a time. */
  isSending: boolean;
}): React.JSX.Element => {
  const skipped = folderSkippedLine(review.manifest.skipped);
  return (
    <EditorialSection title={SEED_FOLDER_REVIEW_TITLE} testID="seed-folder-review">
      <NamespaceField value={review.namespace} onChange={folder.setNamespace} />
      <Text style={styles.summary} testID="seed-folder-notes">
        {folderNotesLine(review.manifest.notes.length)}
      </Text>
      <Text style={styles.hint} testID="seed-folder-bytes">
        {folderSelectedSizeLine(review.selection.bytes)}
      </Text>
      <AttachmentsSwitch
        count={review.manifest.attachments.length}
        value={review.includeAttachments}
        onChange={folder.setIncludeAttachments}
      />
      {skipped ? (
        <Text style={styles.hint} testID="seed-folder-skipped">
          {skipped}
        </Text>
      ) : null}
      <PathList review={review} />
      {review.blocker ? (
        <Text style={styles.blocker} testID="seed-folder-blocker" accessibilityLiveRegion="polite">
          {review.blocker}
        </Text>
      ) : null}
      <ReviewActions
        blocked={review.blocker !== null || isSending}
        onStart={() => void folder.start()}
        onDismiss={folder.dismiss}
      />
    </EditorialSection>
  );
};

const styles = StyleSheet.create({
  label: {
    color: ink.primary,
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  input: {
    backgroundColor: surface.raised,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    color: ink.primary,
    fontSize: NAMESPACE_FONT_SIZE,
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
  },
  hint: {
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  summary: {
    color: ink.primary,
    marginTop: SPACING.md,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.md,
    minHeight: touchTarget.minimum,
  },
  switchLabel: {
    color: ink.primary,
    flex: 1,
  },
  paths: {
    marginTop: SPACING.md,
  },
  path: {
    color: ink.soft,
    marginTop: SPACING.xs,
  },
  blocker: {
    color: ink.primary,
    marginTop: SPACING.md,
  },
  actions: {
    marginTop: SPACING.md,
  },
  start: {
    alignItems: 'center',
    backgroundColor: accent.primary,
    borderRadius: BORDER_RADIUS.md,
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
    paddingHorizontal: SPACING.lg,
  },
  startDisabled: {
    backgroundColor: accent.strong,
  },
  startText: {
    color: accent.onPrimary,
    fontWeight: '600',
  },
  dismiss: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
  },
  dismissText: {
    color: ink.soft,
    fontWeight: '600',
  },
});
