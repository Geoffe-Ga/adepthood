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

/** Facts established by the two behavioural generators in domain/invitations.py. */
const BEHAVIOURAL_REASON: Record<Exclude<InvitationKindT, 'readiness'>, string> = {
  consistency: 'You have kept a habit for three weeks.',
  mastery: 'You have kept a practice cadence for four weeks.',
};

/** The offered door. These name the target without promising an outcome. */
const TARGET_OFFER: Record<Exclude<InvitationTargetTypeT, 'course'>, string> = {
  habit: 'A small daily habit is open to try next.',
  practice: 'A deeper practice is open to explore.',
  sangha: 'The Digital Sangha is open—a place to meet people walking this path.',
  embodied_community:
    'There are people near you walking the same path. The way to meet them is open.',
};

export interface InvitationCopy {
  line: string;
  declineA11y: string;
}

/** One flattened copy row: its target/kind key alongside its rendered strings. */
export interface InvitationCopyEntry extends InvitationCopy {
  targetType: InvitationTargetTypeT;
  kind: InvitationKindT;
}

export interface InvitationCopyContext {
  /** Served stage Aspect. Never substitute relationship_to_free_will here. */
  aspect?: string;
}

const knownAspect = (aspect: string | undefined): string | undefined => {
  const trimmed = aspect?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The readiness generator has two factual sources: a full corpus theme for a
 * course invitation, or activity on 25 of the last 30 days for the outward
 * community invitation. Other readiness pairs are drift-safe fallbacks: the
 * active-days fact remains honest, while the offer only names its target.
 */
const reasonFor = (
  targetType: InvitationTargetTypeT,
  kind: InvitationKindT,
  aspect: string | undefined,
): string => {
  if (kind !== 'readiness') return BEHAVIOURAL_REASON[kind];
  if (targetType === 'course') {
    return aspect
      ? `Your writing has circled ${aspect}.`
      : 'A theme in your writing has grown full enough to stand out.';
  }
  return 'You have been here most days this month.';
};

const offerFor = (targetType: InvitationTargetTypeT, aspect: string | undefined): string => {
  if (targetType !== 'course') return TARGET_OFFER[targetType];
  if (aspect === undefined) return 'A course reading is open to you.';
  return `The ${aspect} reading is open to you.`;
};

const readinessCourseOffer = (aspect: string | undefined): string =>
  aspect ? 'A related reading is available.' : 'A related course reading is available.';

/** Compose the invitation line + its decline accessibility label for a pair. */
export function invitationCopy(
  targetType: InvitationTargetTypeT,
  kind: InvitationKindT,
  context: InvitationCopyContext = {},
): InvitationCopy {
  const aspect = knownAspect(context.aspect);
  return {
    line: `${reasonFor(targetType, kind, aspect)} ${
      targetType === 'course' && kind === 'readiness'
        ? readinessCourseOffer(aspect)
        : offerFor(targetType, aspect)
    }`,
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
