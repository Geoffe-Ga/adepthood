/* eslint-env jest */
/* global describe, test, expect */
import { MANAGED_SEED_DOCUMENT_LABEL, MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
import {
  CORPUS_CTA_BY_DESTINATION,
  SEED_CONSENT_LINK_LABEL,
  SEED_CONSENT_PROMPT,
  SEED_BACKGROUND_NOTE,
  SEED_LEAVE_BROWSER_WARNING,
  SEED_STOP_ALL_LABEL,
  SEED_STOP_BATCH_LABEL,
  seedBatchHeaderLine,
  uploadQueueIndicatorLine,
  SEED_ROW_DESCRIPTION,
  SEED_ROW_LABEL,
  SEED_ROW_VAULT_FIRST_DESCRIPTION,
  SEED_STATUS_LINES,
  SEED_VAULT_INVITATION,
  SEED_VAULT_INVITATION_LINK_LABEL,
  VAULT_FIRST_CTA,
  VAULT_GATE_COPY,
  SEED_PAUSED_PROGRESS_LINE,
  SEED_VAULT_BUSY_PROGRESS_LINE,
  seedProgressLine,
  seedRetryLabel,
  seedSummaryLine,
  seedUnconfirmedLine,
} from '../seedCopy';
import type { SeedItemStatus, SeedRunTally } from '../seedRun';

import type { CorpusDestination } from '@/features/Journal/corpusDestination';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';

/**
 * A run tally from its sendable counts: landed, still to go, failed, and of
 * those failed how many nobody could confirm. Nothing skipped or stopped
 * unless named.
 */
function tally(
  total: number,
  landed: number,
  remaining: number,
  failed: number,
  unconfirmed = 0,
  extra: Partial<Pick<SeedRunTally, 'skipped' | 'stopped'>> = {},
): SeedRunTally {
  return {
    total,
    landed,
    remaining,
    failed,
    unconfirmed,
    skipped: extra.skipped ?? 0,
    stopped: extra.stopped ?? 0,
  };
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
  'attachments_off',
  'app_settings',
  'hidden_file',
  'unsafe_name',
  'name_collision',
  'subscriber_data',
  'unsupported_source',
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
    SEED_BACKGROUND_NOTE,
    SEED_LEAVE_BROWSER_WARNING,
    ...VAULT_GATE_COPY,
  ])('talks about writing, not plumbing: %s', (line) => {
    expect(line).not.toMatch(PLUMBING);
  });
});

describe('the run summary (#3771)', () => {
  test('says nothing before anything is picked', () => {
    expect(seedSummaryLine(tally(0, 0, 0, 0))).toBeNull();
  });

  test('names the four counts in order: landed, failed, remaining, skipped', () => {
    const line = seedSummaryLine(tally(73, 12, 40, 3, 0, { skipped: 18 }));

    expect(line).toBe('12 landed · 3 failed · 40 remaining · 18 skipped (unsupported type)');
  });

  test('always shows all four, zeros included, so the shape never moves', () => {
    expect(seedSummaryLine(tally(3, 3, 0, 0))).toBe(
      '3 landed · 0 failed · 0 remaining · 0 skipped (unsupported type)',
    );
    expect(seedSummaryLine(tally(60, 3, 37, 0, 0, { skipped: 20 }))).toBe(
      '3 landed · 0 failed · 37 remaining · 20 skipped (unsupported type)',
    );
  });

  test('adds what was stopped only when something was', () => {
    expect(seedSummaryLine(tally(5, 1, 0, 0, 0, { stopped: 4 }))).toBe(
      '1 landed · 0 failed · 0 remaining · 0 skipped (unsupported type) · 4 stopped',
    );
  });

  test('keeps the unconfirmed inside failed, with a sub-line of its own', () => {
    // #3239. A lost reply may have landed, so the sub-line says so rather than
    // letting "failed" claim it never arrived.
    const run = tally(4, 1, 0, 3, 2);

    expect(seedSummaryLine(run)).toBe(
      '1 landed · 3 failed · 0 remaining · 0 skipped (unsupported type)',
    );
    expect(seedUnconfirmedLine(run)).toBe(
      "2 of those couldn't be confirmed — they may have arrived. Sending again updates in " +
        'place rather than making a second copy.',
    );
    expect(seedUnconfirmedLine(tally(2, 1, 0, 1, 1))).toMatch(
      /^1 of those couldn't be confirmed — it may have arrived\./u,
    );
    expect(seedUnconfirmedLine(tally(3, 2, 0, 1))).toBeNull();
  });

  test('neither ranks nor shames, and claims no destination it was not told', () => {
    // One pick reaches one destination, but which one is the server's answer
    // per request. A summary naming "your vault" would be the one sentence on
    // this screen that nothing could check.
    const lines = [
      seedSummaryLine(tally(3, 1, 2, 0)),
      seedSummaryLine(tally(3, 3, 0, 0)),
      seedSummaryLine(tally(3, 2, 0, 1)),
      seedSummaryLine(tally(4, 1, 0, 3, 2)),
      seedUnconfirmedLine(tally(4, 1, 0, 3, 2)),
    ];

    for (const line of lines) {
      expect(String(line).toLowerCase()).not.toContain('vault');
      expect(String(line).toLowerCase()).not.toContain('corpus');
      expect(ranksOrShames(String(line))).toBe(false);
    }
  });
});

describe('a skipped file says why, and that nothing was sent (#3771)', () => {
  const SKIPPED: readonly SeedItemStatus[] = [
    'unsupported_format',
    'attachments_off',
    'too_large',
    'app_settings',
    'hidden_file',
    'unsafe_name',
    'name_collision',
    'subscriber_data',
  ];

  test.each(SKIPPED)('%s opens with "Skipped ·" and says it was never sent', (status) => {
    const line = SEED_STATUS_LINES[status];

    expect(line.startsWith('Skipped · ')).toBe(true);
    expect(line).toMatch(/never sent|neither was sent|never was/u);
    expect(ranksOrShames(line)).toBe(false);
  });

  test('a stat or subscriber file says what it lists and that it stays here (#3798)', () => {
    const line = SEED_STATUS_LINES.subscriber_data;

    expect(line).toBe(
      'Skipped · a list of who received or opened a post, so it stays on this device and ' +
        'was never sent.',
    );
    expect(line).not.toMatch(/creek|vault/iu);
  });

  test('the examples read as the issue gives them', () => {
    expect(SEED_STATUS_LINES.attachments_off).toMatch(/^Skipped · attachments are off/u);
    expect(SEED_STATUS_LINES.unsupported_format).toMatch(
      /^Skipped · your vault doesn't read this type/u,
    );
  });

  test('a type the vault turned away says nothing was stored and offers no resend', () => {
    const line = SEED_STATUS_LINES.unsupported_source;

    expect(line.startsWith('Skipped · ')).toBe(true);
    expect(line).toContain('nothing was stored');
    expect(line.toLowerCase()).not.toContain('again');
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

  test('counts only what is being sent, not what was skipped (#3771)', () => {
    // 40 notes and 20 skipped files: the third note of forty, not of sixty.
    expect(seedProgressLine(tally(60, 2, 38, 0, 0, { skipped: 20 }))).toBe('Sending 3 of 40…');
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

describe('a queue that carries on while the person moves around the app (#3772)', () => {
  test('says plainly that leaving Seed carries on, and closing the tab stops it', () => {
    expect(SEED_BACKGROUND_NOTE.toLowerCase()).toContain('carry on');
    expect(SEED_BACKGROUND_NOTE.toLowerCase()).toContain('closing');
    expect(SEED_BACKGROUND_NOTE.toLowerCase()).toContain('stops');
  });

  test('the browser-level warning names what a tab close costs', () => {
    expect(SEED_LEAVE_BROWSER_WARNING.toLowerCase()).toContain('still going over');
    expect(SEED_LEAVE_BROWSER_WARNING.toLowerCase()).toContain('never sent');
  });

  test('the indicator counts what is left, from anywhere', () => {
    expect(uploadQueueIndicatorLine(37)).toBe('Uploading · 37 remaining');
    expect(uploadQueueIndicatorLine(1)).toBe('Uploading · 1 remaining');
  });

  test('the indicator adds what failed once anything has (#3771)', () => {
    expect(uploadQueueIndicatorLine(37, 0)).toBe('Uploading · 37 remaining');
    expect(uploadQueueIndicatorLine(37, 3)).toBe('Uploading · 37 remaining · 3 failed');
  });

  test('each batch header says where it stands, named when it is a folder', () => {
    expect(seedBatchHeaderLine({ name: null, state: 'queued', total: 120, remaining: 120 })).toBe(
      'Queued · 120 files',
    );
    expect(seedBatchHeaderLine({ name: 'Notes', state: 'queued', total: 1, remaining: 1 })).toBe(
      'Notes · Queued · 1 file',
    );
    expect(seedBatchHeaderLine({ name: 'Notes', state: 'sending', total: 40, remaining: 33 })).toBe(
      'Notes · Uploading · 33 remaining',
    );
    expect(seedBatchHeaderLine({ name: null, state: 'settled', total: 40, remaining: 0 })).toBe(
      'Done · 40 files',
    );
  });

  test('both ways to stop say what they stop', () => {
    expect(SEED_STOP_ALL_LABEL.toLowerCase()).toContain('stop');
    expect(SEED_STOP_BATCH_LABEL.toLowerCase()).toContain('stop');
    expect(SEED_STOP_ALL_LABEL).not.toBe(SEED_STOP_BATCH_LABEL);
  });

  test('nothing sold: stopping is a choice, not a lapse', () => {
    expect(ranksOrShames(SEED_BACKGROUND_NOTE)).toBe(false);
    expect(ranksOrShames(SEED_LEAVE_BROWSER_WARNING)).toBe(false);
    expect(ranksOrShames(SEED_STOP_ALL_LABEL)).toBe(false);
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

describe('waiting for a busy vault (#3770)', () => {
  test('the row says it is waiting for the vault', () => {
    expect(SEED_STATUS_LINES.vault_waiting.startsWith('Waiting for your vault…')).toBe(true);
  });

  test('the progress line names the vault, not the pace', () => {
    const tally = {
      total: 3,
      landed: 1,
      remaining: 2,
      failed: 0,
      skipped: 0,
      stopped: 0,
      unconfirmed: 0,
    };

    expect(seedProgressLine(tally, false, true)).toBe(SEED_VAULT_BUSY_PROGRESS_LINE);
    expect(seedProgressLine(tally, true, false)).toBe(SEED_PAUSED_PROGRESS_LINE);
  });

  test('a document the vault stayed busy for says nothing was stored, without blame', () => {
    expect(SEED_STATUS_LINES.vault_busy).toMatch(/nothing was stored/u);
    expect(SEED_STATUS_LINES.vault_busy).not.toMatch(/fail|error/iu);
  });
});
