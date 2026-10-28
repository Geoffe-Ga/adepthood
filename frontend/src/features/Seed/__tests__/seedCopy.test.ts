/* eslint-env jest */
/* global describe, test, expect */
import { MANAGED_SEED_DOCUMENT_LABEL, MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
import {
  CORPUS_CTA_BY_DESTINATION,
  SEED_CONSENT_LINK_LABEL,
  SEED_CONSENT_PROMPT,
  SEED_LEAVE_BROWSER_WARNING,
  SEED_LEAVE_CONFIRM_LABEL,
  SEED_LEAVE_STAY_LABEL,
  SEED_LEAVE_TITLE,
  SEED_LEAVE_WARNING,
  SEED_ROW_DESCRIPTION,
  SEED_ROW_LABEL,
  SEED_ROW_VAULT_FIRST_DESCRIPTION,
  SEED_STATUS_LINES,
  SEED_VAULT_INVITATION,
  SEED_VAULT_INVITATION_LINK_LABEL,
  VAULT_FIRST_CTA,
  VAULT_GATE_COPY,
  SEED_PAUSED_PROGRESS_LINE,
  seedProgressLine,
  seedRetryLabel,
  seedSummaryLine,
} from '../seedCopy';
import type { SeedItemStatus, SeedRunTally } from '../seedRun';

import type { CorpusDestination } from '@/features/Journal/corpusDestination';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';

/** A run tally with no unconfirmed uploads unless one is named. */
function tally(
  total: number,
  landed: number,
  waiting: number,
  refused: number,
  unconfirmed = 0,
): SeedRunTally {
  return { total, landed, waiting, refused, unconfirmed };
}

const EVERY_STATUS: readonly SeedItemStatus[] = [
  'queued',
  'waiting',
  'uploading',
  'ingested',
  'vault_unavailable',
  'capability_unsupported',
  'degraded',
  'in_corpus',
  'consent_required',
  'tier_refused',
  'format_unreadable',
  'not_text',
  'empty_document',
  'document_too_long',
  'unclassified',
  'vault_required',
  'unsupported_format',
  'too_large',
  'managed_too_large',
  'unreadable',
  'failed',
  'rate_limited',
  'unconfirmed',
  'offline',
  'cancelled',
];

describe('what each outcome says', () => {
  test('every status has its own line', () => {
    const lines = EVERY_STATUS.map((status) => SEED_STATUS_LINES[status]);

    expect(lines.filter(Boolean)).toHaveLength(EVERY_STATUS.length);
    expect(new Set(lines).size).toBe(EVERY_STATUS.length);
  });

  test('a vault that cannot take files yet does not read as a failure', () => {
    const line = SEED_STATUS_LINES.capability_unsupported;

    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line).not.toBe(SEED_STATUS_LINES.degraded);
    expect(line.toLowerCase()).toContain('yet');
  });

  test('the unsupported line does not pin the gap on the vault alone', () => {
    // One status covers three causes: a vault too old to take files, a vault
    // whose version this app cannot negotiate with, and a document marked
    // Intimate, which the vault wire cannot express at all. Nothing here can
    // tell which, so "update your vault" would be advice that sometimes cannot
    // work — and the person following it has no way to know when.
    expect(SEED_STATUS_LINES.capability_unsupported).toContain('Adepthood');
  });

  test('the unsupported line names the one remedy the person controls', () => {
    // An Intimate document can never be uploaded at that tier, so a line that
    // only said "wait for one of you to catch up" would leave the person waiting
    // for something that is never coming. Choosing another tier is the fix, and
    // it is theirs to make.
    expect(SEED_STATUS_LINES.capability_unsupported).toContain('Intimate');
  });

  test('an unconfirmed upload never claims the vault was left unchanged', () => {
    // #3052. `degraded` is answered after the document went over the wire, and
    // a vault can keep it and then lose its reply, so the line may only say the
    // outcome is unconfirmed.
    const line = SEED_STATUS_LINES.degraded;

    expect(line.toLowerCase()).toContain('confirm');
    expect(line).not.toMatch(/nothing|wasn't stored|unchanged|never sent|wasn't sent/i);
    expect(line).not.toBe(SEED_STATUS_LINES.failed);
  });

  test('a lost answer says it could not be confirmed, never that nothing was stored', () => {
    // #3239. A timeout, a dropped connection, or an answer the app cannot read
    // can each follow a request the server already kept, so the line says the
    // outcome is unconfirmed and that sending again is safe, as #3238 does.
    const line = SEED_STATUS_LINES.unconfirmed;

    expect(line.toLowerCase()).toContain('confirm');
    expect(line.toLowerCase()).toContain('updates in place');
    expect(line).not.toMatch(/nothing|wasn't stored|unchanged|never sent|wasn't sent/i);
    // No destination is named: which one answered is exactly what was lost.
    expect(line.toLowerCase()).not.toContain('vault');
    expect(line).not.toBe(SEED_STATUS_LINES.degraded);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a device that was offline says the document was never sent', () => {
    const line = SEED_STATUS_LINES.offline;

    expect(line.toLowerCase()).toContain('offline');
    expect(line).toMatch(/wasn't sent/);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a definite refusal keeps saying nothing was stored', () => {
    // `failed` is now only a 4xx answer to the one attempt there was, where the
    // server turned the document away, so "nothing was stored" is a fact.
    expect(SEED_STATUS_LINES.failed).toContain('nothing was stored');
  });

  test('the size refusal names the limit', () => {
    expect(SEED_STATUS_LINES.too_large).toContain(MAX_SEED_DOCUMENT_LABEL);
  });

  test('the managed size refusal is final, says nothing was stored, and names the smaller limit', () => {
    // #3051. The same file can never fit the managed vault's request ceiling, so
    // the line is a refusal of this document -- never an invitation to send it
    // again, and never the rate limit's "give it a minute".
    const line = SEED_STATUS_LINES.managed_too_large;

    expect(line).toContain(MANAGED_SEED_DOCUMENT_LABEL);
    expect(line.toLowerCase()).toContain('too large for your vault');
    expect(line.toLowerCase()).toContain('nothing was stored');
    expect(line).not.toMatch(/try again|send it again|give it a minute/i);
    expect(line).not.toBe(SEED_STATUS_LINES.too_large);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a document in the corpus is not described as being in a vault', () => {
    // The two destinations are different places with different guarantees, and
    // an account with no vault has nothing a "vault" sentence could refer to.
    expect(SEED_STATUS_LINES.in_corpus).toContain('writing');
    expect(SEED_STATUS_LINES.in_corpus.toLowerCase()).not.toContain('vault');
    expect(SEED_STATUS_LINES.in_corpus).not.toBe(SEED_STATUS_LINES.ingested);
  });

  test('a document with nowhere to live is told where that place is set up', () => {
    // #3016. True for every account the server answers this for: one with no
    // vault, one whose vault is still being prepared, one whose vault could not
    // be reached at its stored address. So it never says "set one up" alone.
    const line = SEED_STATUS_LINES.vault_required;

    expect(line).toContain('Nothing was stored');
    expect(line).toContain(VAULT_ROW_LABEL);
    expect(line.toLowerCase()).toContain('check on it');
    expect(line.toLowerCase()).not.toContain('vault');
    expect(line.toLowerCase()).not.toContain('creek');
    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a document in the vault is not described as being in the corpus', () => {
    expect(SEED_STATUS_LINES.ingested).toContain('vault');
  });

  test('the consent answer names the setting and does not read as a failure', () => {
    const line = SEED_STATUS_LINES.consent_required;

    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line.toLowerCase()).toContain('turn that on');
    expect(SEED_CONSENT_LINK_LABEL.toLowerCase()).toContain('setting');
  });

  test('the intimate refusal says why, and names the remedy the person holds', () => {
    const line = SEED_STATUS_LINES.tier_refused;

    expect(line).toContain('Intimate');
    expect(line).toContain('AI');
    expect(line.toLowerCase()).toContain('privacy level');
  });

  test('the unreadable-format answer says what can be read instead', () => {
    // The formats named are the ones the reader enforces: markdown and plain
    // text. A line that promised more would be a promise the code refuses.
    expect(SEED_STATUS_LINES.format_unreadable).toContain('Markdown');
    expect(SEED_STATUS_LINES.format_unreadable).toContain('plain text');
  });

  test('nothing sold: the consent prompt states the fact and offers the way there', () => {
    expect(SEED_CONSENT_PROMPT).toContain('Nothing was stored');
    expect(ranksOrShames(SEED_CONSENT_PROMPT)).toBe(false);
  });
});

describe('the words a person reads beneath a document', () => {
  // Storage and request vocabulary — the corpus, its tiers and entries, the
  // batch, the encoding — is the system's own. A person brought in their
  // writing and chose how private it is, and the lines say it in those words.
  const PLUMBING = /\bcorpus\b|\btiers?\b|\bbatch\b|UTF-8|language model|\bimported\b|in flight/i;

  test.each(EVERY_STATUS)('%s talks about writing, not plumbing', (status) => {
    expect(SEED_STATUS_LINES[status]).not.toMatch(PLUMBING);
  });

  test.each([
    SEED_CONSENT_PROMPT,
    SEED_CONSENT_LINK_LABEL,
    SEED_LEAVE_WARNING,
    SEED_LEAVE_BROWSER_WARNING,
    ...VAULT_GATE_COPY,
  ])('talks about writing, not plumbing: %s', (line) => {
    expect(line).not.toMatch(PLUMBING);
  });
});

describe('the run summary', () => {
  test('says nothing before anything is picked', () => {
    expect(seedSummaryLine(tally(0, 0, 0, 0))).toBeNull();
  });

  test('counts what is still going', () => {
    expect(seedSummaryLine(tally(3, 1, 2, 0))).toContain('3');
  });

  test('names what landed and what did not, without dressing it up', () => {
    const line = seedSummaryLine(tally(3, 2, 0, 1));

    expect(line).toContain('2');
    expect(line).toContain('1');
  });

  test('counts unconfirmed uploads apart from those that did not go over', () => {
    // #3239. "Didn't go over" would claim an unconfirmed upload never arrived.
    const line = String(seedSummaryLine(tally(4, 1, 0, 1, 2)));

    expect(line).toBe("1 of 4 landed. 1 didn't go over. 2 couldn't be confirmed.");
  });

  test('says only what is true when every miss is unconfirmed', () => {
    const line = String(seedSummaryLine(tally(3, 2, 0, 0, 1)));

    expect(line).toBe("2 of 3 landed. 1 couldn't be confirmed.");
    expect(line).not.toContain("didn't go over");
  });

  test('keeps the plain count when nothing is unconfirmed', () => {
    expect(seedSummaryLine(tally(3, 2, 0, 1))).toBe("2 of 3 landed. 1 didn't go over.");
    expect(seedSummaryLine(tally(3, 3, 0, 0))).toBe('All 3 have landed.');
  });

  test('claims no destination it was not told', () => {
    // One pick reaches one destination, but which one is the server's answer
    // per request. A summary naming "your vault" would be the one sentence on
    // this screen that nothing could check.
    const lines = [
      seedSummaryLine(tally(3, 1, 2, 0)),
      seedSummaryLine(tally(3, 3, 0, 0)),
      seedSummaryLine(tally(3, 2, 0, 1)),
      seedSummaryLine(tally(4, 1, 0, 1, 2)),
    ];

    for (const line of lines) {
      expect(String(line).toLowerCase()).not.toContain('vault');
      expect(String(line).toLowerCase()).not.toContain('corpus');
    }
  });
});

describe('a document the run never got to', () => {
  test('says it never left the device, and does not read as a failure', () => {
    const line = SEED_STATUS_LINES.cancelled;

    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line.toLowerCase()).toContain('never sent');
    expect(ranksOrShames(line)).toBe(false);
  });
});

describe('the line shown while documents are going over', () => {
  test('says nothing when nothing is in flight', () => {
    expect(seedProgressLine(tally(0, 0, 0, 0))).toBeNull();
    expect(seedProgressLine(tally(3, 3, 0, 0))).toBeNull();
  });

  test('names the position in the run and how long the run is', () => {
    // Two settled and one in flight of twelve: the third document.
    expect(seedProgressLine(tally(12, 2, 10, 0))).toContain('3 of 12');
  });

  test('counts the whole run rather than only the latest pick', () => {
    // A second pick appends, so the position has to include what a first pick
    // already sent -- otherwise the number restarts while the list does not.
    expect(seedProgressLine(tally(12, 5, 7, 0))).toContain('6 of 12');
  });

  test('claims no destination it was not told', () => {
    const line = String(seedProgressLine(tally(4, 1, 3, 0)));

    expect(line.toLowerCase()).not.toContain('vault');
    expect(line.toLowerCase()).not.toContain('corpus');
  });
});

describe('the warning before leaving a run in flight', () => {
  test('names what is happening and what becomes of each half of the run', () => {
    expect(SEED_LEAVE_TITLE.toLowerCase()).toContain('still going over');
    expect(SEED_LEAVE_WARNING.toLowerCase()).toContain('finish');
    expect(SEED_LEAVE_WARNING.toLowerCase()).toContain('never sent');
  });

  test('offers both ways out, each labelled with what it does', () => {
    expect(SEED_LEAVE_CONFIRM_LABEL.toLowerCase()).toContain('leave');
    expect(SEED_LEAVE_STAY_LABEL.toLowerCase()).toContain('stay');
    expect(SEED_LEAVE_CONFIRM_LABEL).not.toBe(SEED_LEAVE_STAY_LABEL);
  });

  test('the browser-level warning says the same thing in one line', () => {
    expect(SEED_LEAVE_BROWSER_WARNING.toLowerCase()).toContain('still going over');
    expect(SEED_LEAVE_BROWSER_WARNING.toLowerCase()).toContain('never sent');
  });

  test('nothing sold: leaving is a choice, not a lapse', () => {
    expect(ranksOrShames(SEED_LEAVE_WARNING)).toBe(false);
    expect(ranksOrShames(SEED_LEAVE_BROWSER_WARNING)).toBe(false);
    expect(ranksOrShames(SEED_LEAVE_CONFIRM_LABEL)).toBe(false);
  });
});

describe('the way in when there is nowhere to keep a document yet (#3017)', () => {
  test('keeps the row named as it always was, with its original description', () => {
    expect(SEED_ROW_LABEL).toBe('Bring in your writing');
    expect(SEED_ROW_DESCRIPTION).toBe(
      'Add notes, exports, and documents you have already written elsewhere.',
    );
  });

  test('says, in the row itself, where the place for a corpus is set up', () => {
    expect(SEED_ROW_VAULT_FIRST_DESCRIPTION).toContain(VAULT_ROW_LABEL);
    expect(SEED_ROW_VAULT_FIRST_DESCRIPTION).not.toBe(SEED_ROW_DESCRIPTION);
  });

  test('offers the vault-first step as a place to live, not as a task', () => {
    expect(VAULT_FIRST_CTA).toBe('Give your writing a place to live');
  });

  test('pairs each corpus destination with the words that open it', () => {
    const ctas: Record<CorpusDestination, string> = CORPUS_CTA_BY_DESTINATION;

    expect(ctas).toEqual({
      CorpusConsent: 'Look at the decision',
      SeedCorpus: SEED_ROW_LABEL,
      VaultSettings: VAULT_FIRST_CTA,
    });
  });

  test('the seeding screen names the place and the way there', () => {
    expect(SEED_VAULT_INVITATION).toContain('with the rest of your writing');
    expect(SEED_VAULT_INVITATION_LINK_LABEL).toContain(VAULT_ROW_LABEL);
  });

  test('exposes every new line to the sweep', () => {
    expect(VAULT_GATE_COPY).toEqual(
      expect.arrayContaining([
        SEED_ROW_LABEL,
        SEED_ROW_DESCRIPTION,
        SEED_ROW_VAULT_FIRST_DESCRIPTION,
        VAULT_FIRST_CTA,
        SEED_VAULT_INVITATION,
        SEED_VAULT_INVITATION_LINK_LABEL,
        ...Object.values(CORPUS_CTA_BY_DESTINATION),
      ]),
    );
  });

  test.each(VAULT_GATE_COPY)('no line ranks, pressures or talks plumbing: %s', (line) => {
    expect(ranksOrShames(line)).toBe(false);
    expect(line).not.toMatch(/creek/i);
    expect(line).not.toMatch(/https?|\burl\b|endpoint|server/i);
    expect(line).not.toMatch(/\bmust\b|have to|need to|\blose\b|\blost\b|missing out/i);
  });
});

describe('a document held for a moment (#3556)', () => {
  test('the wait reads as calm and as next, never as a failure', () => {
    const line = SEED_STATUS_LINES.waiting;

    expect(line).not.toBe(SEED_STATUS_LINES.queued);
    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line.toLowerCase()).not.toMatch(/fail|error|refus/);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a pause that ran out says nothing was stored and it can go again', () => {
    const line = SEED_STATUS_LINES.rate_limited;

    expect(line).not.toBe(SEED_STATUS_LINES.failed);
    expect(line).toContain('nothing was stored');
    expect(line.toLowerCase()).toContain('again');
    expect(ranksOrShames(line)).toBe(false);
  });

  test('the progress line says the run is pausing, not sending, while it waits', () => {
    expect(seedProgressLine(tally(30, 20, 10, 0), true)).toBe(SEED_PAUSED_PROGRESS_LINE);
    expect(seedProgressLine(tally(30, 20, 10, 0), false)).toContain('21 of 30');
    expect(seedProgressLine(tally(30, 30, 0, 0), true)).toBeNull();
  });

  test.each([SEED_PAUSED_PROGRESS_LINE, seedRetryLabel(1), seedRetryLabel(3)])(
    'talks about writing, not plumbing: %s',
    (line) => {
      expect(ranksOrShames(line)).toBe(false);
      expect(line).not.toMatch(/\bcorpus\b|\bbatch\b|429|rate.?limit/i);
    },
  );

  test('the retry offer counts what it will send', () => {
    expect(seedRetryLabel(1)).toBe('Try that one again');
    expect(seedRetryLabel(3)).toBe('Try those 3 again');
  });
});
