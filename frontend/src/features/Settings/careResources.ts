/**
 * ``STANDING_CARE`` — the always-available Support & care payload shown in
 * Settings (issue #892). Unlike the reactive ``CareSupportNote`` (which appears
 * only when a resonance pass screens an entry as carrying an acute-distress
 * signal), this is a calm standing invitation: support that is reachable any
 * time, not framed as a response to anything the user just wrote.
 *
 * Canonical source of the copy is ``backend/src/domain/care.py`` (§10 "Wellbeing
 * and care boundaries"): the same four resources, in the same order, with the
 * same non-shaming, non-clinical voice. These constants intentionally mirror
 * that canon so reviewers can keep the two surfaces from drifting; if the canon
 * changes, update both. As there, there is NO diagnosis, NO medication guidance,
 * and NO treatment advice here — only pointers toward human and professional
 * support.
 */
import type { CareResource, CareResponse } from '@/api';

/**
 * A warm, non-shaming standing invitation. It names reaching out to a person as
 * a sign of strength and makes clear that support is here whenever it is wanted —
 * a calm, always-on offer rather than a reaction to a distress signal.
 */
const STANDING_CARE_MESSAGE =
  'Whenever you want it, support is here — and reaching out to a person is a ' +
  'sign of strength, not weakness. You never have to carry a hard moment ' +
  'alone. The people below are here for exactly this, any time, and so is ' +
  'someone you trust.';

/**
 * The four standing support pointers, ordered to lead with the immediate crisis
 * lines, then a trusted person, then ongoing professional care. Mirrors
 * ``CARE_RESOURCES`` in ``backend/src/domain/care.py``.
 */
const STANDING_CARE_RESOURCES: CareResource[] = [
  {
    kind: 'hotline',
    name: '988 Suicide & Crisis Lifeline',
    contact: 'Call or text 988',
    what_it_is:
      'Free, confidential support from a trained human counselor, 24 hours a day, 7 days a week.',
  },
  {
    kind: 'text_line',
    name: 'Crisis Text Line',
    contact: 'Text HOME to 741741',
    what_it_is:
      'Text back and forth with a trained volunteer crisis counselor, any time, for free.',
  },
  {
    kind: 'human',
    name: 'Someone you trust',
    contact: 'Reach out to a friend, family member, or anyone you trust',
    what_it_is:
      "You don't have to explain it perfectly — telling one person you're struggling can make this moment less heavy.",
  },
  {
    kind: 'professional',
    name: 'A mental-health professional',
    contact: 'Contact a therapist, counselor, or your doctor',
    what_it_is:
      'A professional can offer ongoing, personal support. This app builds skill and self-knowledge alongside that care — it never replaces it.',
  },
];

/** The always-available Support & care surface (static, not resonance-driven). */
export const STANDING_CARE: CareResponse = {
  message: STANDING_CARE_MESSAGE,
  resources: STANDING_CARE_RESOURCES,
};

/**
 * Quiet caption stating the app's care boundary: it sits alongside professional
 * care, never in place of it (§10). Kept as a separate constant so it can be
 * rendered as a subdued footnote rather than mixed into the warm message.
 */
export const CARE_LIMITS_LINE = "Adepthood complements professional care; it doesn't replace it.";
