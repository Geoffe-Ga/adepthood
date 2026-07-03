/**
 * Microcopy for the subtle invitation surface (NORTH-STAR §6).
 *
 * Every line reads like a wise friend holding a door open — a resonant,
 * declinable invitation, never a growth nudge, never shame, never urgency.
 * ``invitationCopy`` derives one line + its decline accessibility label from a
 * target/kind pair; ``INVITATION_COPY_ENTRIES`` enumerates all 15 combinations.
 *
 * The target/kind enums are the single source of truth owned by the API schema
 * (``@/api``); this file derives its values and types from there so a new enum
 * member forces a compile error here rather than a silent ``undefined`` line.
 */
import { invitationTargetTypeSchema, invitationKindSchema } from '@/api';
import type { InvitationTargetTypeT, InvitationKindT } from '@/api';

/** The named thing each target invites toward, phrased for the middle of a sentence. */
const TARGET_NOUN: Record<InvitationTargetTypeT, string> = {
  habit: 'a small daily habit',
  practice: 'a practice',
  course: 'the next reading',
  sangha: 'the Digital Sangha',
  embodied_community: 'a gathering near you',
};

/** The gentle framing for each kind — why this door is being opened, softly. */
const KIND_OPENER: Record<InvitationKindT, string> = {
  readiness: 'If it feels right, there’s',
  consistency: 'Whenever you’d like, there’s',
  mastery: 'If you’re curious, there’s a deeper',
};

const LINE_TAIL = 'here, waiting quietly for you.';

export interface InvitationCopy {
  line: string;
  declineA11y: string;
}

/** One flattened copy row: its target/kind key alongside its rendered strings. */
export interface InvitationCopyEntry extends InvitationCopy {
  targetType: InvitationTargetTypeT;
  kind: InvitationKindT;
}

/** Compose the invitation line + its decline accessibility label for a pair. */
export function invitationCopy(
  targetType: InvitationTargetTypeT,
  kind: InvitationKindT,
): InvitationCopy {
  return {
    line: `${KIND_OPENER[kind]} ${TARGET_NOUN[targetType]} ${LINE_TAIL}`,
    declineA11y: 'Dismiss this invitation',
  };
}

/** All 15 target/kind combinations, precomputed for the banned-copy sweep. */
export const INVITATION_COPY_ENTRIES: ReadonlyArray<InvitationCopyEntry> =
  invitationTargetTypeSchema.options.flatMap((targetType) =>
    invitationKindSchema.options.map((kind) => ({
      targetType,
      kind,
      ...invitationCopy(targetType, kind),
    })),
  );
