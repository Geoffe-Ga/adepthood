/* eslint-env jest */
/* global describe, test, expect */
import {
  isSubstackSubscriberCsv,
  SUBSCRIBER_CSV_SUFFIXES,
  SUBSCRIBER_LIST_PREFIX,
} from '../substackSubscriberCsv';

/**
 * What Creek-Vault's Substack ingestor treats as subscriber data, copied from
 * its source so the client predicate cannot drift from it quietly (#3798).
 *
 * `SUBSCRIBER_CSV_SUFFIXES` is `creek/ingest/substack.py:83-85`,
 * `SUBSCRIBER_LIST_PREFIX` is `creek/ingest/substack.py:94`, and
 * `_is_subscriber_csv` at `creek/ingest/substack.py:196-205` is the predicate
 * built from them (Creek-Vault@64cfbcf0): a lowercased name that starts with
 * the prefix and ends with `.csv`, or ends with either suffix.
 *
 * When Creek's values change, change these and the module together.
 */
const CREEK_SUBSCRIBER_CSV_SUFFIXES = ['.delivers.csv', '.opens.csv'];
const CREEK_SUBSCRIBER_LIST_PREFIX = 'email_list';

describe("Creek's subscriber-CSV values, restated (#3798)", () => {
  test('the suffixes are the two Creek names, and no more', () => {
    expect([...SUBSCRIBER_CSV_SUFFIXES].sort()).toEqual([...CREEK_SUBSCRIBER_CSV_SUFFIXES].sort());
  });

  test('the roster prefix is the one Creek names', () => {
    expect(SUBSCRIBER_LIST_PREFIX).toBe(CREEK_SUBSCRIBER_LIST_PREFIX);
  });
});

describe('isSubstackSubscriberCsv', () => {
  test.each([
    '141234.my-post.delivers.csv',
    '141234.my-post.opens.csv',
    'email_list.csv',
    'email_list.my-publication.csv',
    'email_list_2026-11-01.csv',
  ])('%s lists who received or opened a post', (name) => {
    expect(isSubstackSubscriberCsv(name)).toBe(true);
  });

  test('reads the name case-insensitively, as Creek does', () => {
    expect(isSubstackSubscriberCsv('141234.My-Post.OPENS.CSV')).toBe(true);
    expect(isSubstackSubscriberCsv('141234.my-post.Delivers.Csv')).toBe(true);
    expect(isSubstackSubscriberCsv('Email_List.CSV')).toBe(true);
  });

  test("posts.csv is the export's manifest, not a stat file", () => {
    expect(isSubstackSubscriberCsv('posts.csv')).toBe(false);
  });

  test.each([
    'budget.csv',
    'opens.csv',
    'delivers.csv',
    'my-email_list.csv',
    'email_list.md',
    'email_list',
    '141234.my-post.opens.csv.md',
    '141234.my-post.html',
    '141234.my-post.opens.xlsx',
  ])('%s is an ordinary file', (name) => {
    expect(isSubstackSubscriberCsv(name)).toBe(false);
  });
});
