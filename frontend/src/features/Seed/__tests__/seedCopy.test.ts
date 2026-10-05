/* eslint-env jest */
/* global describe, test, expect */
import { MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
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
  seedProgressLine,
  seedSummaryLine,
} from '../seedCopy';
import type { SeedItemStatus } from '../seedRun';

import type { CorpusDestination } from '@/features/Journal/corpusDestination';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';

const EVERY_STATUS: readonly SeedItemStatus[] = [
  'queued',
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

  test('the size refusal names the limit', () => {
    expect(SEED_STATUS_LINES.too_large).toContain(MAX_SEED_DOCUMENT_LABEL);
  });

  test('a document in the corpus is not described as being in a vault', () => {
    // The two destinations are different places with different guarantees, and
    // an account with no vault has nothing a "vault" sentence could refer to.
    expect(SEED_STATUS_LINES.in_corpus).toContain('corpus');
    expect(SEED_STATUS_LINES.in_corpus.toLowerCase()).not.toContain('vault');
    expect(SEED_STATUS_LINES.in_corpus).not.toBe(SEED_STATUS_LINES.ingested);
  });

  test('a document with nowhere to live is told where that place is set up', () => {
    // #3016. True for every account the server answers this for: one with no
    // vault, one whose vault is still being prepared, one whose vault could not
    // be reached at its stored address. So it never says "set one up" alone.
    const line = SEED_STATUS_LINES.vault_required;

    expect(line).toContain('Nothing was stored');
    expect(line).toContain('Where your corpus lives');
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
    expect(SEED_CONSENT_LINK_LABEL.toLowerCase()).toContain('settings');
  });

  test('the intimate refusal says why, and names the remedy the person holds', () => {
    const line = SEED_STATUS_LINES.tier_refused;

    expect(line).toContain('Intimate');
    expect(line).toContain('language model');
    expect(line.toLowerCase()).toContain('another tier');
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

describe('the run summary', () => {
  test('says nothing before anything is picked', () => {
    expect(seedSummaryLine({ total: 0, landed: 0, waiting: 0, refused: 0 })).toBeNull();
  });

  test('counts what is still going', () => {
    expect(seedSummaryLine({ total: 3, landed: 1, waiting: 2, refused: 0 })).toContain('3');
  });

  test('names what landed and what did not, without dressing it up', () => {
    const line = seedSummaryLine({ total: 3, landed: 2, waiting: 0, refused: 1 });

    expect(line).toContain('2');
    expect(line).toContain('1');
  });

  test('claims no destination it was not told', () => {
    // One pick reaches one destination, but which one is the server's answer
    // per request. A summary naming "your vault" would be the one sentence on
    // this screen that nothing could check.
    const lines = [
      seedSummaryLine({ total: 3, landed: 1, waiting: 2, refused: 0 }),
      seedSummaryLine({ total: 3, landed: 3, waiting: 0, refused: 0 }),
      seedSummaryLine({ total: 3, landed: 2, waiting: 0, refused: 1 }),
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
    expect(seedProgressLine({ total: 0, landed: 0, waiting: 0, refused: 0 })).toBeNull();
    expect(seedProgressLine({ total: 3, landed: 3, waiting: 0, refused: 0 })).toBeNull();
  });

  test('names the position in the run and how long the run is', () => {
    // Two settled and one in flight of twelve: the third document.
    expect(seedProgressLine({ total: 12, landed: 2, waiting: 10, refused: 0 })).toContain(
      '3 of 12',
    );
  });

  test('counts the whole run rather than only the latest pick', () => {
    // A second pick appends, so the position has to include what a first pick
    // already sent -- otherwise the number restarts while the list does not.
    expect(seedProgressLine({ total: 12, landed: 5, waiting: 7, refused: 0 })).toContain('6 of 12');
  });

  test('claims no destination it was not told', () => {
    const line = String(seedProgressLine({ total: 4, landed: 1, waiting: 3, refused: 0 }));

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
    expect(VAULT_FIRST_CTA).toBe('Give your corpus a place to live');
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
    expect(SEED_VAULT_INVITATION).toContain('where your corpus lives');
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
