import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';

import { auth, journal, resonance, setTokenGetter } from '@/api';
import type { JournalClassification } from '@/api';

/**
 * Asking a finished page for its resonance, across the wire.
 *
 * Two P1 field reports came out of this one feature in a single session: the
 * affordance was unreachable on a saved entry, and pressing it could yield
 * nothing and say nothing. Both were found by hand, because nothing pressed
 * the pass end to end. Every half is green on its own — the domain's anchoring
 * has pytest, the screen's margin has Jest against a mocked client — and the
 * seam between them is where both defects lived.
 *
 * The lane runs the backend's default provider, `BOTMASON_PROVIDER` unset,
 * which is the configured stub: no key, no network, no third party, and a
 * canned reading that quotes the page it was handed. So a pass here is a real
 * pass — the real route, the real wallet, the real anchoring, the real rows —
 * with only the model's sentences canned.
 *
 * The journey has two endings and both are asserted, because the reported
 * defect lives in the second one. A pass can legitimately keep nothing, and
 * what the writer must never get is a button that visibly does nothing: they
 * get the server's own sentence saying why, and their charge back. The stub
 * declines exactly when it has no sentence to copy, so the unpunctuated page
 * below is how this lane reaches that half.
 *
 * What this spec does NOT claim is that any of it renders. The API lane runs on
 * the node environment with `node_modules` untransformed and cannot mount a
 * React Native screen at all (the constraint recorded on
 * `welcome.first-run-walkthrough-to-journal`). The margin's placement and its
 * empty-state copy are pinned by the Jest specs beside `JournalEntryScreen`;
 * what is proven here is that the note the margin will draw is a note the
 * server actually kept, anchored to characters the writer actually wrote.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
// One sale binds to one active account (ADR 0008), so this journey mints its own.
const LICENSE_KEY = freshLicenseKey();

/** A finished page with sentences in it: the stub has something to quote. */
const READABLE_PAGE =
  'The willow bent all night and did not break. I slept badly and woke grateful, ' +
  'which is not the trade I would have chosen.';
/**
 * A page with no sentence boundary anywhere in it. The stub will not paraphrase,
 * so it has nothing it is willing to quote and declines — the same shape a real
 * model's decline takes, and the only way this lane reaches the unhappy half.
 */
const UNQUOTABLE_PAGE = 'the willow bending all night without once breaking and me awake under it';
/** Never sent to any provider, stub or otherwise (the privacy floor). */
const INTIMATE_PAGE = 'What I have not said out loud yet, I am writing here instead.';

const email = `e2e-resonance-${randomUUID()}${EMAIL_DOMAIN}`;

/** Unwrap a value the journey cannot continue without. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the server returned no ${what}`);
  }
  return value;
}

/**
 * Write a page and finish it, which is the state the reported defect was found
 * in: a saved entry the writer came back to, not a draft under the cursor.
 */
async function writeFinishedPage(
  message: string,
  classification?: JournalClassification,
): Promise<number> {
  const entry = await journal.create({ message, classification });
  const finished = await journal.update(entry.id, { status: 'finished' });

  expect(finished.status).toBe('finished');
  // The body is what every anchor below is measured against; an entry the
  // server rewrote on the way in would make those assertions meaningless.
  expect(finished.message).toBe(message);
  return entry.id;
}

describe('asking a page for its resonance, against a live server', () => {
  let sessionToken: string | null = null;
  let readableEntryId = 0;
  let keptNoteId = 0;
  /** Messages left after the charged pass; every later assertion is relative to it. */
  let remainingAfterCharge = 0;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);
    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('keeps a note anchored to the words the writer actually wrote', async () => {
    readableEntryId = await writeFinishedPage(READABLE_PAGE);

    const pass = await resonance.generate(readableEntryId);

    // The entry is not intimate, so the privacy floor must not have withheld it.
    expect(pass.private).not.toBe(true);
    // A pass that kept notes carries no explanation: the notes are the answer.
    expect(pass.no_notes_message ?? null).toBeNull();
    expect(pass.marginalia.length).toBeGreaterThan(0);

    const note = required(pass.marginalia[0], 'margin note');
    // The claim that matters, and the one nothing else in the repo makes across
    // the wire: the span the server persisted selects the snapshot it stored,
    // out of the body this spec wrote a moment ago. A note anchored to indices
    // the model supplied, or to a paraphrase, fails right here.
    expect(READABLE_PAGE.slice(note.anchor_start, note.anchor_end)).toBe(note.anchor_text);
    expect(READABLE_PAGE).toContain(note.anchor_text);
    expect(note.anchor_end).toBeGreaterThan(note.anchor_start);
    // The page is written so the quotable sentence is NOT its first: a span the
    // server hard-coded to zero would satisfy every assertion above on a page
    // quoted from its head, and this is what makes them mean something.
    expect(note.anchor_start).toBeGreaterThan(0);
    expect(note.journal_entry_id).toBe(readableEntryId);
    expect(note.status).toBe('active');
    expect(note.note.trim()).not.toBe('');
    keptNoteId = note.id;

    remainingAfterCharge = pass.remaining_messages;
  });

  it('serves the same note back on the next read, so the margin survives the reload', async () => {
    const listed = await resonance.list(readableEntryId);

    const note = required(
      listed.items.find((row) => row.id === keptNoteId),
      'persisted margin note',
    );
    expect(READABLE_PAGE.slice(note.anchor_start, note.anchor_end)).toBe(note.anchor_text);
    expect(note.status).toBe('active');
  });

  it('answers a pass that keeps nothing with a sentence, and puts the charge back', async () => {
    const entryId = await writeFinishedPage(UNQUOTABLE_PAGE);

    const pass = await resonance.generate(entryId);

    expect(pass.private).not.toBe(true);
    expect(pass.marginalia).toEqual([]);
    // The reported defect, asserted directly: a pass that keeps nothing must
    // still say something. An empty 200 the client has to interpret is the
    // button that visibly does nothing.
    const explanation = pass.no_notes_message ?? '';
    expect(explanation.trim()).not.toBe('');
    // And it must not have cost anything. The charge commits before the
    // provider call and is reversed by a crediting entry, so a balance that
    // moved here means the writer paid for silence.
    expect(pass.remaining_messages).toBe(remainingAfterCharge);

    const listed = await resonance.list(entryId);
    expect(listed.items).toEqual([]);
  });

  it('never sends an intimate page to the provider, and never charges for saying so', async () => {
    const entryId = await writeFinishedPage(INTIMATE_PAGE, 'intimate');

    const pass = await resonance.generate(entryId);

    // The privacy floor answers before the wallet, before the provider, before
    // any usage row: no notes, no charge, and its own non-shaming sentence
    // rather than the zero-note explanation, which would be a different claim.
    expect(pass.private).toBe(true);
    expect((pass.private_message ?? '').trim()).not.toBe('');
    expect(pass.marginalia).toEqual([]);
    expect(pass.no_notes_message ?? null).toBeNull();
    expect(pass.remaining_messages).toBe(remainingAfterCharge);

    const listed = await resonance.list(entryId);
    expect(listed.items).toEqual([]);
  });
});
