/* eslint-env jest */
/* global describe, it, expect, jest */
import { accent } from '../tokens';

/**
 * The writing-field focus treatment.
 *
 * ``writingFieldFocus`` resolves from ``Platform.OS`` at module load (the same
 * trick ``serifStack`` uses in ``tokens.ts``), so each spec re-requires the
 * module with the platform already pinned rather than mutating a frozen value.
 */
function loadFocusStyle(os: string): Record<string, unknown> {
  let style: Record<string, unknown> = {};
  jest.isolateModules(() => {
    // ``isolateModules`` hands the isolated tokens module its own copy of
    // ``react-native``; pin the platform on that copy, not the outer one.
    (require('react-native') as { Platform: { OS: string } }).Platform.OS = os;
    style = require('../tokens').writingFieldFocus as Record<string, unknown>;
  });
  return style;
}

describe('writingField caret token', () => {
  it('dyes the caret the terracotta emphasis accent', () => {
    const { writingField } = require('../tokens') as { writingField: { caret: string } };
    expect(writingField.caret).toBe(accent.strong);
  });
});

describe('writingFieldFocus', () => {
  it('drops the browser focus ring on web so no blue box frames the page', () => {
    expect(loadFocusStyle('web').outlineStyle).toBe('none');
  });

  it('paints the web caret in the accent so it is findable without the ring', () => {
    expect(loadFocusStyle('web').caretColor).toBe(accent.strong);
  });

  it('adds nothing on native, where no focus ring is drawn', () => {
    expect(loadFocusStyle('ios')).toEqual({});
    expect(loadFocusStyle('android')).toEqual({});
  });
});
