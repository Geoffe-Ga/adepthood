/* eslint-env jest */
/* global describe, test, expect */
import type { VaultFolder } from '@/api';
import {
  VAULT_FOLDER_WRITERLESS_REASONS,
  VAULT_DOCUMENT_STAGES,
  VAULT_STAGE_OUTCOMES,
} from '@/api/schemas';
import {
  areaNote,
  areaSummary,
  batchCountsLine,
  childLabel,
  childNote,
  CORPUS_TOTALS_HEADING,
  CORPUS_TOTALS_NONE_WORKED,
  CORPUS_TOTALS_NOTHING_SENT,
  filesOfLine,
  indexedLine,
  documentStageLabel,
  documentStageMark,
  folderLabel,
  folderNote,
  landedInLine,
  passLine,
  receiptLine,
  sentLandedLine,
  sentNotLandedLine,
  stageLeftLine,
  withheldLine,
  VAULT_CREEK_HEADING,
  VAULT_DASHBOARD_LEAD,
  VAULT_UPDATE_NEEDED,
  WRITERLESS_LINE,
} from '@/features/Settings/vaultDashboardCopy';
import { groupFolderAreas } from '@/features/Settings/vaultDashboardModel';
import { SHAPE_FOLDERS } from '@/testing/vaultPipelineFixtures';

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
    'a writerless folder (%s) says it does not fill on its own, and why, in words',
    (reason) => {
      const note = folderNote(folder({ writer: null, writer_reason: reason }));

      expect(note?.startsWith(WRITERLESS_LINE)).toBe(true);
      expect(note).not.toMatch(TOKEN_SHAPE);
    },
  );

  test('a writerless folder with no reason given still says it does not fill on its own', () => {
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

describe('area words', () => {
  const areas = groupFolderAreas(SHAPE_FOLDERS);
  const childAt = (of: ReturnType<typeof area>, index: number) => {
    const child = of.children[index];
    if (child === undefined) throw new Error(`no child ${String(index)} in ${of.path}`);
    return child;
  };
  const area = (path: string) => {
    const found = areas.find((a) => a.path === path);
    if (found === undefined) throw new Error(`no area ${path}`);
    return found;
  };

  test('a child is named within its area, without repeating the area', () => {
    expect(childLabel('01-Fragments/Writing/Substack', '01-Fragments')).toBe('Writing · Substack');
    expect(childLabel('11-Other-Authors/ai-as-user', '11-Other-Authors')).toBe('AI as user');
  });

  test('an area that holds something sums up its filled children on one line', () => {
    expect(areaSummary(area('01-Fragments'))).toBe('Writing · Substack 212');
    expect(areaSummary(area('03-Eddies'))).toBeNull();
    expect(areaNote(area('01-Fragments'))).toBeNull();
  });

  test('an empty area with a writer says once what fills it', () => {
    expect(areaNote(area('04-Praxis'))).toBe(
      'Nothing here yet — fills as practices surface in your writing.',
    );
    expect(areaNote(area('10-Liminal'))).toBe(
      'Nothing here yet — fills as your writing is worked through.',
    );
    expect(areaSummary(area('04-Praxis'))).toBeNull();
  });

  test('an empty area nothing writes to says Creek does not fill it, without a reason', () => {
    expect(areaNote(area('09-Reference'))).toBe(`${WRITERLESS_LINE}.`);
  });

  test('folders kept together at their area are said once', () => {
    expect(indexedLine(2)).toBe('Notes for all 2 of its folders are kept together here.');
    expect(indexedLine(1)).toBe('Notes for its one folder are kept together here.');
  });

  test('an open area’s rows explain only what the area line did not', () => {
    const praxis = area('04-Praxis');
    const liminal = area('10-Liminal');
    const authors = area('11-Other-Authors');

    expect(childNote(childAt(praxis, 0), praxis)).toBeNull();
    expect(childNote(childAt(liminal, 1), liminal)).toBe(
      'Nothing here yet — fills as tensions in your writing come to light.',
    );
    expect(childNote(childAt(area('09-Reference'), 0), area('09-Reference'))).toBe(
      `${WRITERLESS_LINE} — it's yours to fill.`,
    );
    expect(childNote(childAt(authors, 0), authors)).toBe(
      `${WRITERLESS_LINE} — it is an example that came with your vault.`,
    );
  });
});

describe('whole-corpus totals (#3796)', () => {
  const none = { turnedAway: 0, notLanded: 0, unconfirmed: 0 };

  test('"x of y files" groups its digits and never becomes a share of anything', () => {
    expect(filesOfLine(1180, 1240)).toBe('1,180 of 1,240 files');
    expect(filesOfLine(0, 12)).toBe('0 of 12 files');
    expect(filesOfLine(1, 1)).toBe('1 of 1 file');
    expect(filesOfLine(1180, 1240)).not.toMatch(/%/u);
  });

  test('the sent line says how many landed of how many were sent', () => {
    expect(sentLandedLine(1240, 1243)).toBe('1,240 of 1,243 files landed');
    expect(sentLandedLine(1, 1)).toBe('1 of 1 file landed');
  });

  test('nothing is said about files that did not land when every one did', () => {
    expect(sentNotLandedLine(none)).toBeNull();
  });

  test('each way a file did not land is counted in its own words', () => {
    expect(sentNotLandedLine({ ...none, turnedAway: 3 })).toBe('3 turned away for their file type');
    expect(sentNotLandedLine({ ...none, turnedAway: 1 })).toBe('1 turned away for its file type');
    expect(sentNotLandedLine({ ...none, notLanded: 2 })).toBe("2 didn't land");
    expect(sentNotLandedLine({ ...none, unconfirmed: 1 })).toBe("1 couldn't be confirmed");
    expect(sentNotLandedLine({ turnedAway: 1200, notLanded: 2, unconfirmed: 1 })).toBe(
      "1,200 turned away for their file type · 2 didn't land · 1 couldn't be confirmed",
    );
  });

  test('a stage says what it left, and nothing when it left nothing', () => {
    expect(stageLeftLine(0, 0)).toBeNull();
    expect(stageLeftLine(60, 0)).toBe('60 partly done');
    expect(stageLeftLine(0, 3)).toBe("3 didn't finish");
    expect(stageLeftLine(1060, 3)).toBe("1,060 partly done · 3 didn't finish");
  });

  test('new words say "your Corpus", and name neither the engine nor the old room', () => {
    const lines = [
      CORPUS_TOTALS_HEADING,
      CORPUS_TOTALS_NOTHING_SENT,
      CORPUS_TOTALS_NONE_WORKED,
      sentLandedLine(1240, 1243),
      sentNotLandedLine({ turnedAway: 1, notLanded: 1, unconfirmed: 1 }) ?? '',
      stageLeftLine(1, 1) ?? '',
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/creek|vault/iu);
      expect(line).not.toMatch(TOKEN_SHAPE);
    }
    expect(CORPUS_TOTALS_NOTHING_SENT).toContain('your Corpus');
    expect(CORPUS_TOTALS_NONE_WORKED).toContain('Your Corpus');
  });
});

/**
 * The dashboard never names the software behind it (#3803, epic #3802). Where
 * that name was only the doer of a verb the sentence drops the doer; where a
 * doer is needed, it is "your Corpus".
 */
describe('the dashboard speaks of your Corpus', () => {
  test('the lead, the heading and the update notice say what was done, not who did it', () => {
    expect(VAULT_DASHBOARD_LEAD).toBe(
      'What has come in, what has been done with it, and which rooms of your vault are still quiet.',
    );
    expect(VAULT_CREEK_HEADING).toBe('What has been done with your Corpus');
    expect(VAULT_UPDATE_NEEDED).toBe(
      'Your vault needs an update to show this. What it holds, and what has been done with each file, will show here once it has one.',
    );
  });

  test('a folder left to its owner reads as one sentence', () => {
    expect(folderNote(folder({ writer: null, writer_reason: 'owner_curated' }))).toBe(
      "This one doesn't fill on its own — it's yours to fill.",
    );
    expect(folderNote(folder({ writer: null, writer_reason: 'container' }))).toBe(
      "This one doesn't fill on its own — it holds the folders beneath it.",
    );
  });

  test.each([
    ['generate.voice', 'fills as your Corpus learns how you write'],
    ['generate.lexicon', 'fills as your Corpus learns the words you return to'],
    ['generate.wavelength', 'fills as the phases your writing moves through are mapped'],
    ['generate.something-new', 'fills as your writing is worked through'],
  ])('an empty %s folder says what fills it', (writer, fills) => {
    expect(folderNote(folder({ writer }))).toBe(`Nothing here yet — ${fills}.`);
  });

  test('a pass that did not finish, or did not say, names your Corpus', () => {
    expect(passLine({ stage: 'threads', state: 'unfinished', emitted: 0, failureCode: null })).toBe(
      "Threads — didn't finish: your Corpus will try again on its next pass.",
    );
    expect(passLine({ stage: 'eddies', state: 'unconfirmed', emitted: 0, failureCode: null })).toBe(
      "Eddies — may have finished; your Corpus didn't say",
    );
  });
});
