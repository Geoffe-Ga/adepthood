/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  LINE_SIMILARITY_THRESHOLD,
  MAX_SEAM_LINES,
  MIN_FRAGMENT_CHARS,
  MIN_OVERLAP_LINES,
  MIN_SINGLE_LINE_OVERLAP_CHARS,
  findSeamOverlap,
  lineSimilarity,
  normalizeTranscriptLine,
  seamLines,
} from '../transcriptOverlap';

/**
 * Two screenshots of one message thread usually overlap: the bottom of the first
 * is the top of the second, often with a line cropped at each edge. These tests
 * pin the one matcher that decides which repeated lines the merge may drop — and,
 * just as importantly, every case where it must keep a line the writer really did
 * write twice.
 */

// The issue's headline example: page 2 starts on the cropped tail of a line from
// page 1, and page 1 ends on a line cropped short that page 2 shows whole.
const SAM_PAGE_1 = [
  'Sam: Are you still coming tonight?',
  'Me: Yes — leaving at 6.',
  'Sam: Can you grab ice on the way?',
  'Me: Sure, how many bags',
].join('\n');
const SAM_PAGE_2 = [
  'leaving at 6.',
  'Sam: Can you grab ice on the way?',
  'Me: Sure, how many bags?',
  'Sam: Two should do it. Thank you!',
].join('\n');

const LINE_A = 'Morning pages, written slowly by the window.';
const LINE_B = 'The kettle clicked off before I noticed it.';
const LINE_C = 'Nothing urgent today, which felt like a gift.';
const LINE_D = 'I want to remember how quiet the street was.';
const LINE_E = 'Later I walked down to the river and back.';

const lines = (...rows: string[]): string => rows.join('\n');

/** A string of exactly `length` characters from one repeated letter. */
function run(letter: string, length: number): string {
  return letter.repeat(length);
}

/** `base` with its first `count` characters swapped for a different letter. */
function substituted(base: string, count: number): string {
  return 'z'.repeat(count) + base.slice(count);
}

describe('findSeamOverlap — cropped-edge message thread (the issue example)', () => {
  it('findSeamOverlap collapses the cropped-edge message-thread example into one copy of each line', () => {
    expect(findSeamOverlap(SAM_PAGE_1, SAM_PAGE_2)).toEqual({
      laterLinesToDrop: 2,
      earlierLinesToReplace: 1,
      noticeLineCount: 3,
    });
  });

  it('replaces a cropped trailing line with the whole one, never fuzzily matching it', () => {
    // "me: sure, how many bags" is 0.958 similar to its whole partner, so a
    // matcher that lets the fuzzy threshold swallow a cropped tail would keep the
    // partial line and drop the complete one ({3, 0, 3}). The cropped tail must
    // always be the thing replaced.
    const overlap = findSeamOverlap(SAM_PAGE_1, SAM_PAGE_2);
    expect(overlap?.earlierLinesToReplace).toBe(1);
    expect(overlap?.laterLinesToDrop).not.toBe(3);
  });
});

describe('findSeamOverlap — exact overlap', () => {
  it('drops the k = 2 lines the later page repeats', () => {
    expect(findSeamOverlap(lines(LINE_A, LINE_B, LINE_C), lines(LINE_B, LINE_C, LINE_D))).toEqual({
      laterLinesToDrop: 2,
      earlierLinesToReplace: 0,
      noticeLineCount: 2,
    });
  });

  it('prefers the longest run: k = 4', () => {
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, LINE_D, LINE_E),
        lines(LINE_B, LINE_C, LINE_D, LINE_E, 'And then it rained.'),
      ),
    ).toEqual({ laterLinesToDrop: 4, earlierLinesToReplace: 0, noticeLineCount: 4 });
  });

  it('ignores the whitespace at a page edge', () => {
    expect(
      findSeamOverlap(`${lines(LINE_A, LINE_B, LINE_C)}\n\n`, `\n${lines(LINE_B, LINE_C)}`),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 0, noticeLineCount: 2 });
  });

  it('drops every line of a later page that wholly repeats the earlier one', () => {
    expect(findSeamOverlap(lines(LINE_B, LINE_C), lines(LINE_B, LINE_C, LINE_D))).toEqual({
      laterLinesToDrop: 2,
      earlierLinesToReplace: 0,
      noticeLineCount: 2,
    });
  });

  it('prefers the longest run when a line repeats at the seam', () => {
    // A doubled line could also align as a one-line run; the longer run is the
    // truer reading, and dropping only one copy would leave a repeat behind.
    expect(findSeamOverlap(lines(LINE_A, LINE_B, LINE_B), lines(LINE_B, LINE_B, LINE_D))).toEqual({
      laterLinesToDrop: 2,
      earlierLinesToReplace: 0,
      noticeLineCount: 2,
    });
  });

  it('prefers the alignment that accounts for a cropped tail over a looser one', () => {
    // Page 1's second copy of the line is page 2's second line cut short; aligning
    // it as a plain repeat would keep the partial copy.
    expect(findSeamOverlap(lines(LINE_A, LINE_A), lines(LINE_A, `${LINE_A} Then more.`))).toEqual({
      laterLinesToDrop: 1,
      earlierLinesToReplace: 1,
      noticeLineCount: 2,
    });
  });

  it('finds nothing when the pages share no lines', () => {
    expect(findSeamOverlap(lines(LINE_A, LINE_B), lines(LINE_C, LINE_D))).toBeNull();
  });

  it('finds nothing when either page is empty', () => {
    expect(findSeamOverlap('', lines(LINE_A, LINE_B))).toBeNull();
    expect(findSeamOverlap(lines(LINE_A, LINE_B), '')).toBeNull();
  });
});

describe('normalizeTranscriptLine', () => {
  it.each([
    ['collapses runs of spaces and tabs', 'Me:  Sure,\thow   many', 'me: sure, how many'],
    ['trims both ends', '   Me: ok  ', 'me: ok'],
    ['straightens curly apostrophes', 'I’ll ‘be’ there', "i'll 'be' there"],
    ['straightens curly double quotes', '“Sure”', '"sure"'],
    ['turns an en dash into a hyphen', 'six–seven', 'six-seven'],
    ['turns an em dash into a hyphen', 'six—seven', 'six-seven'],
    ['turns a minus sign into a hyphen', '6−3', '6-3'],
    ['casefolds', 'SAM: HELLO', 'sam: hello'],
    ['applies NFKC (a full-width letter and a non-breaking space)', 'Ａ b', 'a b'],
  ])('%s', (_label, raw, normalized) => {
    expect(normalizeTranscriptLine(raw)).toBe(normalized);
  });

  // Short lines, so a missing normalization cannot hide behind the fuzzy threshold:
  // each pair is under 0.9 similar until it is normalized.
  it.each([
    ['whitespace', 'Me:   sure   thing\nSam:  ok  then', 'Me: sure thing\nSam: ok then'],
    [
      'curly vs straight apostrophes',
      "I'd've, y'all\nMe: y'know",
      'I\u2019d\u2019ve, y\u2019all\nMe: y\u2019know',
    ],
    [
      'curly vs straight quotes',
      'Sam: "soon"\nMe: "ok"',
      'Sam: \u201Csoon\u201D\nMe: \u201Cok\u201D',
    ],
    [
      'en and em dash vs hyphen',
      'Six - seven - ok\nMe: 6-7',
      'Six \u2014 seven \u2013 ok\nMe: 6\u20137',
    ],
    ['case', 'SAM: HELLO THERE\nME: HI', 'sam: hello there\nme: hi'],
  ])('matches a two-line run that differs only in %s', (_label, tail, head) => {
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 0, noticeLineCount: 2 });
  });
});

describe('lineSimilarity and the fuzzy threshold', () => {
  const base = run('a', 100);

  it('scores identical lines 1 and two empty lines 1', () => {
    expect(lineSimilarity('abc', 'abc')).toBe(1);
    expect(lineSimilarity('', '')).toBe(1);
  });

  it('scores by edit distance over the longer length', () => {
    expect(lineSimilarity('kitten', 'sitting')).toBe(1 - 3 / 7);
    expect(lineSimilarity('abc', '')).toBe(0);
    expect(lineSimilarity('', 'abc')).toBe(0);
  });

  it('scores exactly 0.9 for 10 substitutions in 100 characters', () => {
    expect(lineSimilarity(base, substituted(base, 10))).toBe(LINE_SIMILARITY_THRESHOLD);
  });

  it('scores exactly 0.89 for 11 substitutions in 100 characters', () => {
    expect(lineSimilarity(base, substituted(base, 11))).toBe(0.89);
  });

  it('matches lines at exactly the threshold', () => {
    const tail = lines(base, run('b', 100));
    const head = lines(substituted(base, 10), substituted(run('b', 100), 10));
    expect(findSeamOverlap(lines(LINE_A, tail), head)).toEqual({
      laterLinesToDrop: 2,
      earlierLinesToReplace: 0,
      noticeLineCount: 2,
    });
  });

  it('does not match lines at 0.89', () => {
    const tail = lines(base, run('b', 100));
    const head = lines(substituted(base, 11), run('b', 100));
    expect(findSeamOverlap(lines(LINE_A, tail), head)).toBeNull();
  });
});

describe('findSeamOverlap — never a false merge', () => {
  it('keeps a short reply that happens to sit at both edges', () => {
    expect(
      findSeamOverlap(lines('Sam: See you there?', 'Me: ok'), lines('Me: ok', 'Sam: Great.')),
    ).toBeNull();
  });

  it('keeps a single matching line one character under the single-line minimum', () => {
    const short = run('q', MIN_SINGLE_LINE_OVERLAP_CHARS - 1);
    expect(findSeamOverlap(lines(LINE_A, short), lines(short, LINE_E))).toBeNull();
  });

  it('drops a single matching line exactly at the single-line minimum', () => {
    const long = run('q', MIN_SINGLE_LINE_OVERLAP_CHARS);
    expect(findSeamOverlap(lines(LINE_A, long), lines(long, LINE_E))).toEqual({
      laterLinesToDrop: 1,
      earlierLinesToReplace: 0,
      noticeLineCount: 1,
    });
  });

  it('measures the single-line minimum on the shorter of the two matched lines', () => {
    // 24 vs 23 normalized characters, similarity 23/24 ≥ 0.9: still too short.
    const long = `${run('q', MIN_SINGLE_LINE_OVERLAP_CHARS - 1)}x`;
    const short = run('q', MIN_SINGLE_LINE_OVERLAP_CHARS - 1);
    expect(findSeamOverlap(lines(LINE_A, long), lines(short, LINE_E))).toBeNull();
  });

  it('never counts cropped fragments toward the minimum', () => {
    // One short full line, framed by a cropped head fragment and a cropped tail:
    // three "notice" lines, but only one real match, and it is short.
    const earlier = lines(
      'Sam: Are we still on for dinner tonight?',
      'Me: ok',
      'Sam: What time works',
    );
    const later = lines('on for dinner tonight?', 'Me: ok', 'Sam: What time works for you?');
    expect(findSeamOverlap(earlier, later)).toBeNull();
  });

  it('never counts a cropped head fragment alone toward the minimum', () => {
    const earlier = lines('Sam: Are we still on for dinner tonight?', 'Me: ok');
    const later = lines('on for dinner tonight?', 'Me: ok', 'Sam: Great.');
    expect(findSeamOverlap(earlier, later)).toBeNull();
  });

  it.each(['[illegible]', '[no text found]'])(
    'never matches the %s marker, even when identical across the seam',
    (marker) => {
      expect(
        findSeamOverlap(lines(LINE_A, marker, marker), lines(marker, marker, LINE_E)),
      ).toBeNull();
    },
  );

  it('lets a marker line break a run rather than join it', () => {
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, '[illegible]', LINE_C),
        lines(LINE_B, '[illegible]', LINE_C, LINE_E),
      ),
    ).toBeNull();
  });

  it('lets a blank line break a run rather than join it', () => {
    expect(
      findSeamOverlap(lines(LINE_A, LINE_B, '', LINE_C), lines(LINE_B, '', LINE_C, LINE_E)),
    ).toBeNull();
  });
});

describe('findSeamOverlap — a different value is never a repeat', () => {
  // Each pair is ≥ 0.9 similar by edit distance alone, but says something
  // different: merging would silently swap the later page's value for the earlier.
  it.each([
    [
      'a number',
      'Day 14: walked 3 miles along the river path.\nSlept well after the long day out.',
      'Day 12: walked 3 miles along the river path.\nSlept well after the long day out.',
    ],
    [
      'a time',
      'Sam: Dinner is at 7:30 at the usual place, ok?\nMe: Sounds good, see you there then.',
      'Sam: Dinner is at 6:30 at the usual place, ok?\nMe: Sounds good, see you there then.',
    ],
    [
      'an emoji',
      'Sam: I cannot believe what happened today \u{1F602}\nMe: Tell me everything tonight please',
      'Sam: I cannot believe what happened today \u{1F62D}\nMe: Tell me everything tonight please',
    ],
    [
      'a symbol',
      'Me: The total came to about forty dollars %\nSam: Fine, I will pay you back later on.',
      'Me: The total came to about forty dollars $\nSam: Fine, I will pay you back later on.',
    ],
  ])('keeps two lines that differ only in %s', (_label, tail, head) => {
    expect(
      lineSimilarity(
        normalizeTranscriptLine(tail.split('\n')[0] ?? ''),
        normalizeTranscriptLine(head.split('\n')[0] ?? ''),
      ),
    ).toBeGreaterThanOrEqual(LINE_SIMILARITY_THRESHOLD);
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toBeNull();
  });

  it('still merges a genuine letter-level OCR slip', () => {
    const tail = 'Day 14: walked 3 miles along the river path.\nSlept well after the long day out.';
    const head = 'Day 14: walkcd 3 miles along the rivcr path.\nSlept well after the long day out.';
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 0, noticeLineCount: 2 });
  });

  it('keeps two lines whose values match but in a different order', () => {
    const tail = 'Me: I got there at 3 and left again at 5 today.\nSam: Long afternoon, then.';
    const head = 'Me: I got there at 5 and left again at 3 today.\nSam: Long afternoon, then.';
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toBeNull();
  });

  it('treats a slipped vowel sign as a letter slip, not a different value', () => {
    // Devanagari vowel signs are combining marks that NFKC does not fold away.
    const tail =
      'Me: \u0906\u091C \u0926\u093F\u0928 \u092C\u0939\u0941\u0924 \u0905\u091A\u094D\u091B\u093E \u0925\u093E \u0926\u094B\u0938\u094D\u0924\u0964\nSam: Lovely, we should go back.';
    const head =
      'Me: \u0906\u091C \u0926\u0940\u0928 \u092C\u0939\u0941\u0924 \u0905\u091A\u094D\u091B\u093E \u0925\u093E \u0926\u094B\u0938\u094D\u0924\u0964\nSam: Lovely, we should go back.';
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 0, noticeLineCount: 2 });
  });

  it('treats an accented letter as a letter, not a symbol', () => {
    // NFKC composes it, and a combining mark still counts as part of a letter.
    const tail =
      'Me: the cafe\u0301 was quiet this morning again.\nSam: Lovely, we should go back.';
    const head =
      'Me: the cafe\u0301 was quiot this morning again.\nSam: Lovely, we should go back.';
    expect(
      findSeamOverlap(lines('Opening line of the page.', tail), lines(head, 'Fresh line.')),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 0, noticeLineCount: 2 });
  });

  it('replaces a letter-cropped tail even though it is fuzzily similar to its whole line', () => {
    // 'me: sure, how many bag' is a 0.96-similar prefix with the same symbols as
    // its whole partner: only the cropped-tail rule stops it being kept.
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, 'Me: Sure, how many bag'),
        lines(LINE_B, LINE_C, 'Me: Sure, how many bags', LINE_D),
      ),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 1, noticeLineCount: 3 });
  });
});

describe('findSeamOverlap — cropped fragments', () => {
  it('drops a cropped head fragment that ends a line on the earlier page', () => {
    expect(
      findSeamOverlap(
        lines('Me: Yes — leaving at 6.', LINE_B, LINE_C),
        lines('leaving at 6.', LINE_B, LINE_C, LINE_D),
      ),
    ).toEqual({ laterLinesToDrop: 3, earlierLinesToReplace: 0, noticeLineCount: 3 });
  });

  it('keeps a head fragment shorter than the fragment minimum', () => {
    const fragment = run('w', MIN_FRAGMENT_CHARS - 1);
    expect(
      findSeamOverlap(
        lines(`Me: ${fragment}`, LINE_B, LINE_C),
        lines(fragment, LINE_B, LINE_C, LINE_D),
      ),
    ).toBeNull();
  });

  it('drops a head fragment exactly at the fragment minimum', () => {
    const fragment = run('w', MIN_FRAGMENT_CHARS);
    expect(
      findSeamOverlap(
        lines(`Me: ${fragment}`, LINE_B, LINE_C),
        lines(fragment, LINE_B, LINE_C, LINE_D),
      ),
    ).toEqual({ laterLinesToDrop: 3, earlierLinesToReplace: 0, noticeLineCount: 3 });
  });

  it('never treats a whole identical line as its own cropped fragment', () => {
    // L[0] equals the earlier line before the run: that is not a strictly
    // shorter suffix, so it is not a crop.
    expect(
      findSeamOverlap(lines(LINE_A, LINE_E, LINE_B, LINE_C), lines(LINE_E, LINE_B, LINE_C, LINE_D)),
    ).toEqual({ laterLinesToDrop: 3, earlierLinesToReplace: 0, noticeLineCount: 3 });
  });

  it('never drops an identical marker line as a cropped head fragment', () => {
    // A strictly-shorter check: '[illegible]' is a suffix of itself, but not a crop.
    expect(
      findSeamOverlap(
        lines('[illegible]', LINE_B, LINE_C),
        lines('[illegible]', LINE_B, LINE_C, LINE_D),
      ),
    ).toBeNull();
  });

  it('replaces a cropped tail with its whole line from the later page', () => {
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, 'Me: Sure, how many'),
        lines(LINE_B, LINE_C, 'Me: Sure, how many bags?', LINE_D),
      ),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 1, noticeLineCount: 3 });
  });

  it('keeps a cropped tail shorter than the fragment minimum', () => {
    const tail = run('t', MIN_FRAGMENT_CHARS - 1);
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, tail),
        lines(LINE_B, LINE_C, `${tail}!!`, LINE_D),
      ),
    ).toBeNull();
  });

  it('replaces a cropped tail exactly at the fragment minimum', () => {
    const tail = run('t', MIN_FRAGMENT_CHARS);
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, tail),
        lines(LINE_B, LINE_C, `${tail}!!`, LINE_D),
      ),
    ).toEqual({ laterLinesToDrop: 2, earlierLinesToReplace: 1, noticeLineCount: 3 });
  });

  it('never treats an identical marker line as a cropped tail', () => {
    // '[illegible]' is a prefix of itself, but not strictly shorter, so it is not a
    // crop — and a marker never matches, so the seam is left whole.
    expect(
      findSeamOverlap(
        lines(LINE_A, LINE_B, LINE_C, '[illegible]'),
        lines(LINE_B, LINE_C, '[illegible]', LINE_D),
      ),
    ).toBeNull();
  });
});

describe('findSeamOverlap — bounded', () => {
  // Wholly different lines (one letter each), so no two are even fuzzily alike.
  const LETTERS = 'abcdefghijklmnopqrstuvwxy';
  const LINE_LENGTH = 30;
  const distinct = (count: number): string[] =>
    Array.from(LETTERS.slice(0, count), (letter) => letter.repeat(LINE_LENGTH));

  it('finds a run of exactly MAX_SEAM_LINES lines', () => {
    const shared = distinct(MAX_SEAM_LINES);
    expect(findSeamOverlap(lines(LINE_A, ...shared), lines(...shared, LINE_E))).toEqual({
      laterLinesToDrop: MAX_SEAM_LINES,
      earlierLinesToReplace: 0,
      noticeLineCount: MAX_SEAM_LINES,
    });
  });

  it('never looks past MAX_SEAM_LINES lines from the seam', () => {
    const shared = distinct(MAX_SEAM_LINES + 1);
    expect(findSeamOverlap(lines(...shared), lines(...shared))).toBeNull();
  });

  it('pins the documented constants', () => {
    expect(LINE_SIMILARITY_THRESHOLD).toBe(0.9);
    expect(MIN_OVERLAP_LINES).toBe(2);
    expect(MIN_SINGLE_LINE_OVERLAP_CHARS).toBe(24);
    expect(MIN_FRAGMENT_CHARS).toBe(8);
    expect(MAX_SEAM_LINES).toBe(20);
  });
});

describe('seamLines', () => {
  it('trims the page edges and splits on newlines', () => {
    expect(seamLines('\n a\n b \n\n')).toEqual(['a', ' b']);
  });
});
