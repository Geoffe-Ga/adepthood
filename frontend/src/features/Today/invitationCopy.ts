/**
 * Microcopy for the subtle invitation surface (NORTH-STAR §6).
 *
 * Every line reads like a wise friend holding a door open — a resonant,
 * declinable invitation, never a growth nudge, never shame, never urgency.
 * ``invitationCopy`` derives one line + its decline accessibility label from a
 * target/kind pair; ``INVITATION_COPY_ENTRIES`` enumerates all 15 combinations.
 */

/** The 5 invitation target types the backend can offer (NORTH-STAR §6). */
const TARGET_TYPES = ['habit', 'practice', 'course', 'sangha', 'embodied_community'] as const;

/** The 3 invitation kinds — the moment that occasioned the offer. */
const KINDS = ['readiness', 'consistency', 'mastery'] as const;

/** A backend invitation target type (structurally identical to the API enum). */
export type InvitationTargetType = (typeof TARGET_TYPES)[number];

/** A backend invitation kind. */
export type InvitationKind = (typeof KINDS)[number];

/** The named thing each target invites toward, phrased for the middle of a sentence. */
const TARGET_NOUN: Record<InvitationTargetType, string> = {
  habit: 'a small daily habit',
  practice: 'a practice',
  course: 'the next reading',
  sangha: 'the Digital Sangha',
  embodied_community: 'a gathering near you',
};

/** The gentle framing for each kind — why this door is being opened, softly. */
const KIND_OPENER: Record<InvitationKind, string> = {
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
  targetType: InvitationTargetType;
  kind: InvitationKind;
}

/** Compose the invitation line + its decline accessibility label for a pair. */
export function invitationCopy(
  targetType: InvitationTargetType,
  kind: InvitationKind,
): InvitationCopy {
  return {
    line: `${KIND_OPENER[kind]} ${TARGET_NOUN[targetType]} ${LINE_TAIL}`,
    declineA11y: 'Dismiss this invitation',
  };
}

/** All 15 target/kind combinations, precomputed for the banned-copy sweep. */
export const INVITATION_COPY_ENTRIES: ReadonlyArray<InvitationCopyEntry> = TARGET_TYPES.flatMap(
  (targetType) => KINDS.map((kind) => ({ targetType, kind, ...invitationCopy(targetType, kind) })),
);
