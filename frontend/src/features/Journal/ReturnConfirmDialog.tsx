/**
 * ``ReturnConfirmDialog`` — the one beat between "The Return is open to you"
 * and a Return actually beginning.
 *
 * It exists to say materially what accepting is, in the same small card over
 * the dimmed page that ``DeleteEntryDialog`` uses: five weeks, the server's own
 * weekly foci read straight off ``weeks`` rather than invented here, and the
 * guarantee that the arc can be paused, set down, or simply left. Nothing in it
 * argues for saying yes — NORTH-STAR "you choose your depth" means the
 * confirmation informs and the cancel costs nothing.
 *
 * Presentational: it owns no lifecycle. ``onConfirm`` is fired once per press
 * and the caller decides what a second press means.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import JournalModalShell from './JournalModalShell';

import type { ReturnWeek } from '@/api';
import { BORDER_RADIUS, colors, editorialType, spacing, touchTarget } from '@/design/tokens';
import {
  RETURN_CONFIRM_BODY,
  RETURN_CONFIRM_CANCEL,
  RETURN_CONFIRM_CANCEL_A11Y,
  RETURN_CONFIRM_GUARANTEE,
  RETURN_CONFIRM_HEADING,
  RETURN_CONFIRM_SCRIM_A11Y,
  RETURN_OFFER_ACCEPT,
  RETURN_OFFER_ACCEPT_A11Y,
  buildReturnConfirmWeekLine,
} from '@/features/Return/returnCopy';

/** The arc's weeks, listed as the server named them — this file invents none. */
function ReturnWeekList({ weeks }: { weeks: readonly ReturnWeek[] }): React.JSX.Element {
  return (
    <View testID="contraction-return-weeks">
      {weeks.map((week) => (
        <Text
          key={week.week_number}
          style={styles.week}
          testID={`contraction-return-week-${String(week.week_number)}`}
        >
          {buildReturnConfirmWeekLine(week.week_number, week.title)}
        </Text>
      ))}
    </View>
  );
}

export interface ReturnConfirmDialogProps {
  visible: boolean;
  /** The arc's weeks as the server projected them; an empty list simply lists none. */
  weeks: readonly ReturnWeek[];
  onConfirm: () => void;
  onCancel: () => void;
}

function ReturnConfirmDialog({
  visible,
  weeks,
  onConfirm,
  onCancel,
}: ReturnConfirmDialogProps): React.JSX.Element {
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onCancel}
      scrimTestID="contraction-return-confirm-scrim"
      scrimLabel={RETURN_CONFIRM_SCRIM_A11Y}
      modalTestID="contraction-return-confirm"
      cardTestID="contraction-return-confirm-card"
    >
      <Text style={styles.title} accessibilityRole="header">
        {RETURN_CONFIRM_HEADING}
      </Text>
      <Text style={styles.body}>{RETURN_CONFIRM_BODY}</Text>
      <ReturnWeekList weeks={weeks} />
      <Text style={styles.body}>{RETURN_CONFIRM_GUARANTEE}</Text>
      <TouchableOpacity
        style={styles.confirm}
        onPress={onConfirm}
        accessibilityRole="button"
        accessibilityLabel={RETURN_OFFER_ACCEPT_A11Y}
        testID="contraction-return-confirm-accept"
      >
        <Text style={styles.confirmLabel}>{RETURN_OFFER_ACCEPT}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.cancel}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={RETURN_CONFIRM_CANCEL_A11Y}
        testID="contraction-return-confirm-cancel"
      >
        <Text style={styles.cancelLabel}>{RETURN_CONFIRM_CANCEL}</Text>
      </TouchableOpacity>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingVertical: spacing(1),
  },
  week: {
    ...editorialType.note,
    color: colors.paper.ink,
    paddingVertical: spacing(0.25),
  },
  confirm: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.tier.clear,
    marginTop: spacing(1),
  },
  confirmLabel: {
    ...editorialType.action,
    color: colors.paper.background,
  },
  cancel: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing(0.5),
  },
  cancelLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
    fontWeight: '400',
  },
});

export default ReturnConfirmDialog;
