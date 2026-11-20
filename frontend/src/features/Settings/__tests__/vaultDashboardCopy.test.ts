/* eslint-env jest */
/* global describe, test, expect */
import type { VaultFolder } from '@/api';
import {
  VAULT_FOLDER_WRITERLESS_REASONS,
  VAULT_DOCUMENT_STAGES,
  VAULT_STAGE_OUTCOMES,
} from '@/api/schemas';
import {
  batchCountsLine,
  documentStageLabel,
  documentStageMark,
  folderLabel,
  folderNote,
  landedInLine,
  passLine,
  receiptLine,
  withheldLine,
  WRITERLESS_LINE,
} from '@/features/Settings/vaultDashboardCopy';

/**
 * The words of the "Your vault" dashboard (#3776). Every closed vocabulary the
 * server answers with is worded here, and nothing a person reads is ever the
 * token itself -- ``owner_curated`` or ``linked:eddies`` on screen would be
 * the system talking to itself in front of them.
 */

/** Anything that looks like a wire token: snake_case, a colon pair, or a dotted writer. */
const TOKEN_SHAPE = /[a-z]+_[a-z]+|[a-z]+:[a-z]+|[a-z]+\.[a-z]+/u;

function folder(overrides: Partial<VaultFolder> = {}): VaultFolder {
  return {
    path: '03-Eddies',
    count: 0,
    last_written_at: null,
    writer: 'link.eddies',
    writer_reason: null,
    ...overrides,
  };
}

describe('folderLabel', () => {
  test.each([
    ['04-Praxis/Daily', 'Praxis · Daily'],
    ['01-Fragments/Writing/Substack', 'Fragments · Writing · Substack'],
    ['09-Reference/External-Sources', 'Reference · External Sources'],
    ['10-Liminal/Compost/intimate-stubs', 'Liminal · Compost · Intimate stubs'],
    ['06-Frequencies/F1-Agency', 'Frequencies · F1 Agency'],
    ['11-Other-Authors/ai-as-user', 'Other Authors · AI as user'],
  ])('humanises %s as %s', (path, label) => {
    expect(folderLabel(path)).toBe(label);
  });

  test('says where a file landed without the Fragments shelf every upload shares', () => {
    expect(landedInLine('01-Fragments/Writing/Substack')).toBe('Landed in Writing · Substack');
    expect(landedInLine('10-Liminal/Orphaned')).toBe('Landed in Liminal · Orphaned');
  });
});

describe('folderNote', () => {
  test('an empty folder with a writer says what fills it', () => {
    expect(folderNote(folder())).toBe(
      'Nothing here yet — fills as your writing gathers around a theme.',
    );
  });

  test('a folder with notes in it needs no note', () => {
    expect(folderNote(folder({ count: 9 }))).toBeNull();
  });

  test('a writer this app has no words for still reads as a sentence', () => {
    const note = folderNote(folder({ writer: 'generate.something-new' }));

    expect(note).toMatch(/^Nothing here yet — /u);
    expect(note).not.toContain('generate');
  });

  test.each(VAULT_FOLDER_WRITERLESS_REASONS)(
    'a writerless folder (%s) says Creek does not fill it, and why, in words',
    (reason) => {
      const note = folderNote(folder({ writer: null, writer_reason: reason }));

      expect(note?.startsWith(WRITERLESS_LINE)).toBe(true);
      expect(note).not.toMatch(TOKEN_SHAPE);
    },
  );

  test('a writerless folder with no reason given still says Creek does not fill it', () => {
    expect(folderNote(folder({ writer: null, writer_reason: null }))).toBe(`${WRITERLESS_LINE}.`);
  });
});

describe('stage and pass words', () => {
  test.each(VAULT_DOCUMENT_STAGES)('names the document stage %s in words', (stage) => {
    expect(documentStageLabel(stage)).not.toMatch(TOKEN_SHAPE);
  });

  test.each(VAULT_STAGE_OUTCOMES)('marks the outcome %s in words or a tick', (outcome) => {
    expect(documentStageMark(outcome)).not.toMatch(TOKEN_SHAPE);
  });

  test('a finished pass carries its tick and what it made', () => {
    expect(passLine({ stage: 'eddies', state: 'done', emitted: 9, failureCode: null })).toBe(
      'Eddies ✓ (9)',
    );
    expect(passLine({ stage: 'classify', state: 'done', emitted: 0, failureCode: null })).toBe(
      'Classified ✓',
    );
  });

  test('an unfinished pass says why, in words, for every reason it can carry', () => {
    expect(
      passLine({
        stage: 'classify',
        state: 'unfinished',
        emitted: 0,
        failureCode: 'request_key_rejected',
      }),
    ).toBe("Classified — didn't finish: your own provider key was refused.");
    expect(
      passLine({ stage: 'threads', state: 'unfinished', emitted: 0, failureCode: 'busy' }),
    ).toMatch(/^Threads — didn't finish: /u);
    expect(
      passLine({ stage: 'threads', state: 'unfinished', emitted: 0, failureCode: 'mystery_code' }),
    ).not.toMatch(TOKEN_SHAPE);
  });

  test('running, partly done and unconfirmed passes each read plainly', () => {
    expect(passLine({ stage: 'temporal', state: 'running', emitted: 0, failureCode: null })).toBe(
      'Linked in time — running',
    );
    expect(passLine({ stage: 'classify', state: 'partly', emitted: 3, failureCode: null })).toMatch(
      /^Classified — partly done/u,
    );
    expect(
      passLine({ stage: 'brand_new', state: 'unconfirmed', emitted: 0, failureCode: null }),
    ).not.toMatch(TOKEN_SHAPE);
  });
});

describe('receipts', () => {
  const base = {
    id: 1,
    filename: 'a.md',
    batch: null,
    destination: 'vault',
    vault_ref: null,
    landed_in: null,
    landed_at: '2026-11-20T17:02:11Z',
  };

  test.each([
    ['accepted', '01-Fragments/Notes', 'Landed in Notes'],
    ['accepted', null, 'In your vault'],
    ['degraded', null, "Couldn't be confirmed"],
    ['vault_unavailable', null, "Didn't land — your vault wasn't reachable"],
    ['capability_unsupported', null, "Didn't land — your vault can't take files yet"],
    ['something_new', null, "Didn't land"],
  ])('a %s receipt in %s reads "%s"', (status, landedIn, line) => {
    expect(receiptLine({ ...base, vault_status: status, landed_in: landedIn })).toBe(line);
  });

  test('counts read as counts, never as progress', () => {
    expect(batchCountsLine(212, 0)).toBe('212 landed');
    expect(batchCountsLine(3, 1)).toBe("3 landed · 1 didn't");
  });

  test('withheld documents are counted, never named', () => {
    expect(withheldLine(0)).toBeNull();
    expect(withheldLine(1)).toBe(
      '1 more is above the privacy level shared here, so it is not named.',
    );
    expect(withheldLine(2)).toBe(
      '2 more are above the privacy level shared here, so they are not named.',
    );
  });
});
