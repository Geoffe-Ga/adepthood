/**
 * ``WritingSessionOffer`` — the invitation, inside the finished-session note,
 * to keep what was just written: as a habit, or as a practice.
 *
 * ONE invitation with three actions, not two invitations stacked. Two would
 * mean two declines, and the whole claim this note makes is that saying no
 * costs a single tap — a writer who has to decline twice has been asked twice.
 * So both ways of keeping it sit under one "No thanks", and one stored flag
 * answers all three.
 *
 * Lives in the ``children`` slot ``WritingSessionBanner`` reserves for exactly
 * this, and takes that slot's contract seriously: the offer commits on the tap
 * rather than staging anything, because the slot can be replaced or closed out
 * from under it and a half-filled form would be lost either way.
 *
 * Three properties are the point of this component, and each has a test that
 * fails if it goes:
 *
 * 1. **Declinable in one tap.** "No thanks" is a sibling of the accept, not a
 *    smaller thing beneath it, and pressing it takes the offer away at once.
 * 2. **Declined for good.** The answer is written to device storage and read
 *    before anything renders, so a writer who has said no is never asked again
 *    — not on the next session, not after a relaunch.
 * 3. **No pressure.** There is no count of sessions, no cadence, no praise for
 *    finishing and no consequence named for declining; ``saveAsHabitCopy`` and
 *    ``saveAsPracticeCopy`` hold every string and both are swept for it.
 *
 * The writer's habits are read only when the HABIT branch is taken up, and
 * their practices only when the PRACTICE one is. Someone who ignores the offer,
 * or has declined it, causes no request at all — and taking one branch never
 * spends a request on the other.
 *
 * The practice branch lives in ``SaveAsPracticeStep`` rather than here, because
 * it has to ask the server what keeping it would DO before it can describe the
 * choice honestly, and that lookup has states of its own. What stays here is
 * the switch and the gate: which branch is open, and whether the offer is.
 *
 * Placing the habit is a list, not a drag. ``ReorderHabitsModal`` is where
 * dragging belongs — a management surface, on a screen, with room. This is one
 * row moving inside a note on the page someone is still writing on, so it is
 * two buttons: operable by a screen reader, which a long-press drag is not, and
 * unmissable for a writer who has just spent twenty minutes not looking at
 * controls. The PREVIEW is shared rather than re-derived: the stage each row
 * would land on comes from ``stagePreview``, the same function the write itself
 * stamps from, so what is shown and what is saved cannot drift apart.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { FinishedWriting } from './keepAsPractice';
import OfferAction from './OfferAction';
import {
  JOURNALING_HABIT_ICON,
  JOURNALING_HABIT_NAME,
  SAVE_AS_HABIT_ACCEPT,
  SAVE_AS_HABIT_ACCEPT_A11Y,
  SAVE_AS_HABIT_CANCEL,
  SAVE_AS_HABIT_CANCEL_A11Y,
  SAVE_AS_HABIT_CONFIRM,
  SAVE_AS_HABIT_CONFIRM_A11Y,
  SAVE_AS_HABIT_DECLINE,
  SAVE_AS_HABIT_DECLINE_A11Y,
  SAVE_AS_HABIT_MOVE_EARLIER,
  SAVE_AS_HABIT_MOVE_EARLIER_A11Y,
  SAVE_AS_HABIT_MOVE_LATER,
  SAVE_AS_HABIT_MOVE_LATER_A11Y,
  SAVE_AS_HABIT_PLACE_HELP,
  SAVE_AS_HABIT_PLACE_TITLE,
  SAVE_AS_HABIT_PROMPT,
  SAVE_AS_HABIT_SAVING,
  savedHabitConfirmation,
  stagePreviewLabel,
} from './saveAsHabitCopy';
import { SAVE_AS_PRACTICE_ACCEPT, SAVE_AS_PRACTICE_ACCEPT_A11Y } from './saveAsPracticeCopy';
import SaveAsPracticeStep from './SaveAsPracticeStep';
import type { WritingSessionResult } from './writingSession';

import { BORDER_RADIUS, SPACING, colors, editorialType } from '@/design/tokens';
import { habitManager } from '@/features/Habits/services/habitManager';
import { clampPosition, insertAt, stagePreview } from '@/features/Habits/services/habitOrdering';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useHabitStore } from '@/store/useHabitStore';

/** Where the offer has got to. ``unknown`` is "the decline has not been read yet". */
type Phase = 'unknown' | 'offered' | 'placing' | 'saving' | 'saved' | 'keeping' | 'declined';

/** One row of the prospective order: what it is called, and whose lap it counts on. */
interface PreviewRow {
  key: string;
  name: string;
  is_carryover?: boolean;
}

/** The prospective order, one row per habit, each naming the stage it would take. */
function PreviewList({
  rows,
  newKey,
  onEarlier,
  onLater,
}: {
  rows: readonly PreviewRow[];
  newKey: string;
  onEarlier: () => void;
  onLater: () => void;
}): React.JSX.Element {
  const stages = stagePreview(rows);
  return (
    <View style={styles.list} testID="save-as-habit-preview">
      {rows.map((row, index) => (
        <View
          key={row.key}
          style={[styles.row, row.key === newKey ? styles.rowNew : null]}
          testID={`save-as-habit-row-${index}`}
        >
          <Text style={styles.rowLabel}>{stagePreviewLabel(row.name, stages[index] ?? '')}</Text>
          {row.key === newKey ? (
            <View style={styles.rowControls}>
              <OfferAction
                label={SAVE_AS_HABIT_MOVE_EARLIER}
                a11yLabel={SAVE_AS_HABIT_MOVE_EARLIER_A11Y}
                onPress={onEarlier}
                testID="save-as-habit-move-earlier"
              />
              <OfferAction
                label={SAVE_AS_HABIT_MOVE_LATER}
                a11yLabel={SAVE_AS_HABIT_MOVE_LATER_A11Y}
                onPress={onLater}
                testID="save-as-habit-move-later"
              />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/**
 * Whether this offer has already been answered, and the one way to answer it.
 *
 * ``null`` while the stored flag is still being read, and nothing renders in
 * that state: an offer that flashed up and then vanished on the read landing
 * would be worse than one that arrives a beat late.
 *
 * ``settle`` is called from BOTH endings. Declining is the obvious one. Keeping
 * the habit is the other, and it matters just as much: the habit exists now, so
 * asking again would nag and, if taken up, file a second one beside it.
 */
function useOfferGate(): { answered: boolean | null; settle: () => void } {
  const [answered, setAnswered] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadWritingOfferAnswered().then((stored) => {
      if (mounted) setAnswered(stored);
    });
    return () => {
      mounted = false;
    };
  }, []);
  const settle = useCallback(() => {
    void saveWritingOfferAnswered(true);
  }, []);
  return { answered, settle };
}

/** The chosen position, and the two moves that change it, both bounded. */
function usePlacement(rowCount: number): {
  position: number;
  earlier: () => void;
  later: () => void;
  reset: () => void;
} {
  const [position, setPosition] = useState(0);
  const earlier = useCallback(() => setPosition((at) => Math.max(at - 1, 0)), []);
  const later = useCallback(() => setPosition((at) => clampPosition(rowCount, at + 1)), [rowCount]);
  const reset = useCallback(() => setPosition(0), []);
  return { position, earlier, later, reset };
}

/** The habits as the preview sees them: a name and a lap, nothing else. */
function toPreviewRows(
  habits: ReadonlyArray<{ id: number; name: string; is_carryover?: boolean }>,
): PreviewRow[] {
  return habits.map((habit) => ({
    key: `habit-${habit.id}`,
    name: habit.name,
    is_carryover: habit.is_carryover,
  }));
}

/** The row standing in for the habit that does not exist yet. */
const NEW_ROW: PreviewRow = { key: 'new', name: JOURNALING_HABIT_NAME };

/**
 * The offer as first made: two ways to keep it, and one way to decline.
 *
 * The decline is a sibling of both, at the same size and in the same row —
 * not a smaller thing beneath them — because a note offering two depths and
 * one shallow exit must not make the exit the hardest of the three to find.
 */
function Invitation({
  onKeepAsHabit,
  onKeepAsPractice,
  onDecline,
}: {
  onKeepAsHabit: () => void;
  onKeepAsPractice: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.offer} testID="save-as-habit-offer">
      <Text style={styles.prompt}>{SAVE_AS_HABIT_PROMPT}</Text>
      <View style={styles.actions}>
        <OfferAction
          label={SAVE_AS_HABIT_ACCEPT}
          a11yLabel={SAVE_AS_HABIT_ACCEPT_A11Y}
          onPress={onKeepAsHabit}
          emphasis
          testID="save-as-habit-accept"
        />
        <OfferAction
          label={SAVE_AS_PRACTICE_ACCEPT}
          a11yLabel={SAVE_AS_PRACTICE_ACCEPT_A11Y}
          onPress={onKeepAsPractice}
          emphasis
          testID="save-as-practice-accept"
        />
        <OfferAction
          label={SAVE_AS_HABIT_DECLINE}
          a11yLabel={SAVE_AS_HABIT_DECLINE_A11Y}
          onPress={onDecline}
          testID="save-as-habit-decline"
        />
      </View>
    </View>
  );
}

/** The prospective order, and the two things the writer can do with it. */
function PlacingStep({
  rows,
  saving,
  onEarlier,
  onLater,
  onConfirm,
  onCancel,
}: {
  rows: readonly PreviewRow[];
  saving: boolean;
  onEarlier: () => void;
  onLater: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.offer} testID="save-as-habit-offer">
      <Text style={styles.prompt}>{SAVE_AS_HABIT_PLACE_TITLE}</Text>
      <Text style={styles.help}>{SAVE_AS_HABIT_PLACE_HELP}</Text>
      <PreviewList rows={rows} newKey={NEW_ROW.key} onEarlier={onEarlier} onLater={onLater} />
      <View style={styles.actions}>
        <OfferAction
          label={saving ? SAVE_AS_HABIT_SAVING : SAVE_AS_HABIT_CONFIRM}
          a11yLabel={SAVE_AS_HABIT_CONFIRM_A11Y}
          onPress={onConfirm}
          disabled={saving}
          emphasis
          testID="save-as-habit-confirm"
        />
        <OfferAction
          label={SAVE_AS_HABIT_CANCEL}
          a11yLabel={SAVE_AS_HABIT_CANCEL_A11Y}
          onPress={onCancel}
          testID="save-as-habit-cancel"
        />
      </View>
    </View>
  );
}

/**
 * The clock, as a module-level constant so its identity never changes.
 *
 * An inline default would be a new function on every render, which is exactly
 * what would let the end instant below be re-read — the thing the ``useState``
 * initialiser exists to prevent.
 */
const systemClock = (): Date => new Date();

export interface WritingSessionOfferProps {
  /** The session this offer is about — what it would record if taken up. */
  result: WritingSessionResult;
  /** The clock the end instant is read from; tests inject it, production does not. */
  now?: () => Date;
}

/** Everything the writer can do from the note, and the phase each move lands in. */
interface OfferMoves {
  phase: Phase;
  decline: () => void;
  keepAsHabit: () => void;
  keepAsPractice: () => void;
  practiceKept: () => void;
  confirmHabit: () => void;
  backToOffer: () => void;
}

/**
 * The moves, in one place, so the component below only chooses what to render.
 *
 * ``settle`` is called from all three endings — declining, keeping the habit,
 * keeping the practice — and from none of the ways back, because an offer the
 * writer stepped out of is one they have not answered.
 */
function useOfferMoves(settle: () => void, placement: ReturnType<typeof usePlacement>): OfferMoves {
  const [phase, setPhase] = useState<Phase>('offered');

  const decline = useCallback(() => {
    settle();
    setPhase('declined');
  }, [settle]);

  const keepAsHabit = useCallback(() => {
    // Read the writer's habits only now: an offer nobody takes up costs no
    // request, and the list is what the next step is about.
    void habitManager.loadHabits();
    placement.reset();
    setPhase('placing');
  }, [placement]);

  const confirmHabit = useCallback(() => {
    setPhase('saving');
    void habitManager
      .insertHabitAt(
        { name: JOURNALING_HABIT_NAME, icon: JOURNALING_HABIT_ICON },
        placement.position,
      )
      .then((saved) => {
        // Only a write that landed settles the offer. A rolled-back one leaves
        // it open, because the writer asked for a habit they have not got.
        if (saved) settle();
        setPhase(saved ? 'saved' : 'placing');
      });
  }, [placement.position, settle]);

  return {
    phase,
    decline,
    keepAsHabit,
    keepAsPractice: useCallback(() => setPhase('keeping'), []),
    practiceKept: useCallback(() => settle(), [settle]),
    confirmHabit,
    backToOffer: useCallback(() => setPhase('offered'), []),
  };
}

function WritingSessionOffer({
  result,
  now = systemClock,
}: WritingSessionOfferProps): React.JSX.Element | null {
  const habits = useHabitStore((state) => state.habits);
  const { answered, settle } = useOfferGate();
  const placement = usePlacement(habits.length);
  const { phase, decline, keepAsHabit, keepAsPractice, practiceKept, confirmHabit, backToOffer } =
    useOfferMoves(settle, placement);
  // Stamped ONCE, at mount, and never re-read. The note appears when the session
  // ends and is keyed to it, so mount time is the session's own end instant;
  // reading the clock again at the tap would post-date the writing to whenever
  // the writer got round to answering — minutes later, on a page they are still
  // typing on. A ``useState`` initialiser rather than a memo, because a memo is
  // a cache React is allowed to drop and this is a fact about one session.
  const [writing] = useState<FinishedWriting>(() => ({
    endedAt: now(),
    elapsedMs: result.elapsedMs,
  }));

  if (answered !== false || phase === 'declined') return null;

  if (phase === 'saved') {
    return (
      <View style={styles.offer} testID="save-as-habit-saved">
        <Text style={styles.prompt}>{savedHabitConfirmation()}</Text>
      </View>
    );
  }

  if (phase === 'keeping') {
    return <SaveAsPracticeStep writing={writing} onKept={practiceKept} onCancel={backToOffer} />;
  }

  if (phase === 'placing' || phase === 'saving') {
    return (
      <PlacingStep
        rows={insertAt(toPreviewRows(habits), NEW_ROW, placement.position)}
        saving={phase === 'saving'}
        onEarlier={placement.earlier}
        onLater={placement.later}
        onConfirm={confirmHabit}
        onCancel={backToOffer}
      />
    );
  }

  return (
    <Invitation onKeepAsHabit={keepAsHabit} onKeepAsPractice={keepAsPractice} onDecline={decline} />
  );
}

const styles = StyleSheet.create({
  offer: {
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  prompt: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  help: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
  list: {
    marginTop: SPACING.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  /** The row being placed, marked so the eye finds it without a colour claim. */
  rowNew: {
    backgroundColor: colors.paper.anchorHighlight,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.xs,
  },
  rowLabel: {
    ...editorialType.note,
    color: colors.paper.ink,
    flexShrink: 1,
  },
  rowControls: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
});

export default WritingSessionOffer;
