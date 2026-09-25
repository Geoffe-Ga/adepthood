/**
 * ``ReviewScopePicker`` — the list of reviews a writer could begin early, one
 * row per scope in progress today (issue #2867).
 *
 * Deliberately navigation-agnostic: it neither owns the trigger that opens it
 * nor decides where a choice goes. The shelf mounts it under its own quiet
 * "Start a review early" link; the Promoted quotes screen (#2865) can mount it
 * under a "Write a review" button of its own. Each hands in ``onChoose``, which
 * receives the JournalEntry params from :func:`reviewEntryParams` — continue a
 * review already begun, or begin a fresh one.
 *
 * It never throws: a failed lookup says so in one honest line, and the daily
 * page beside it is untouched.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  PICKER_EMPTY,
  PICKER_UNAVAILABLE,
  beginReviewA11y,
  continueReviewA11y,
  continueReviewLabel,
} from './reviewInvitationCopy';
import {
  resolveStageTitles,
  reviewEntryParams,
  reviewTitle,
  sortByReviewOrder,
  type ReviewEntryParams,
} from './reviewScopes';

import { reflections } from '@/api';
import type { ReflectionCurrentScope } from '@/api';
import { Button } from '@/components/Button';
import { SPACING, editorialType, ink } from '@/design/tokens';

/** Where the picker's one fetch stands. ``idle`` until it is first opened. */
export type ReviewScopesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One open scope, with the stage title its program name needs (null for non-stage scopes). */
export interface PickableScope {
  scope: ReflectionCurrentScope;
  stageTitle: string | null;
  title: string;
}

/** Fetch today's open scopes, ordered and titled. Rejects on any failure. */
async function loadPickableScopes(): Promise<PickableScope[]> {
  const { scopes } = await reflections.current();
  const ordered = sortByReviewOrder(scopes);
  const titles = await resolveStageTitles(ordered);
  return ordered.map((scope) => {
    const stageTitle = titles.get(scope.scope_key) ?? null;
    return { scope, stageTitle, title: reviewTitle(scope, stageTitle) };
  });
}

/**
 * The scopes in progress today, fetched each time ``enabled`` turns true.
 * Exported so a screen with its own layout can list them without this view.
 */
export function useCurrentReviewScopes({ enabled }: { enabled: boolean }): {
  status: ReviewScopesStatus;
  scopes: PickableScope[];
} {
  const [status, setStatus] = useState<ReviewScopesStatus>('idle');
  const [scopes, setScopes] = useState<PickableScope[]>([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    setStatus('loading');
    loadPickableScopes().then(
      (loaded) => {
        if (!active) return;
        setScopes(loaded);
        setStatus('ready');
      },
      () => {
        if (!active) return;
        setScopes([]);
        setStatus('error');
      },
    );
    return () => {
      active = false;
    };
  }, [enabled]);

  return { status, scopes };
}

export interface ReviewScopePickerProps {
  /** Whether the list is open; nothing is fetched or shown until it is. */
  enabled: boolean;
  /** Receives where the chosen review should open. */
  onChoose: (_params: ReviewEntryParams) => void;
}

/** One pressable row: begin a fresh review, or continue one already begun. */
function ScopeRow({
  item,
  onChoose,
}: {
  item: PickableScope;
  onChoose: (_params: ReviewEntryParams) => void;
}): React.JSX.Element {
  const { scope, stageTitle, title } = item;
  const resuming = scope.existing_entry_id != null;
  return (
    <Button
      variant="tertiary"
      label={resuming ? continueReviewLabel(title) : title}
      accessibilityLabel={resuming ? continueReviewA11y(title) : beginReviewA11y(title)}
      testID={`journal-review-scope-${scope.level}`}
      onPress={() => onChoose(reviewEntryParams(scope, stageTitle))}
      style={styles.row}
    />
  );
}

function ReviewScopePicker({
  enabled,
  onChoose,
}: ReviewScopePickerProps): React.JSX.Element | null {
  const { status, scopes } = useCurrentReviewScopes({ enabled });
  if (!enabled || status === 'idle' || status === 'loading') return null;
  if (status === 'error') return <Text style={styles.note}>{PICKER_UNAVAILABLE}</Text>;
  if (scopes.length === 0) return <Text style={styles.note}>{PICKER_EMPTY}</Text>;
  return (
    <View style={styles.list}>
      {scopes.map((item) => (
        <ScopeRow key={item.scope.scope_key} item={item} onChoose={onChoose} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingTop: SPACING.xs,
  },
  row: {
    // A list of quiet links, read down the left edge like the shelf itself.
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
  },
  note: {
    ...editorialType.note,
    color: ink.soft,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xs,
  },
});

export default ReviewScopePicker;
