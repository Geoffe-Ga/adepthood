/* eslint-env jest */
/* global describe, it, expect */
/**
 * Cross-boundary guard: the composer's bounds and vocabularies are copies of the
 * intake contract's, and this suite fails the moment either side moves alone.
 */
import { pyClassFields, pyInt, pyStrEnum, pyString } from './pythonSource';

import type { FeedbackCreate } from '@/api';
import {
  FEEDBACK_PUBLIC_ID_PATTERN,
  feedbackCategorySchema,
  feedbackImpactSchema,
} from '@/api/schemas';
import * as bounds from '@/features/Feedback/feedbackBounds';
import { FEEDBACK_CATEGORY_ORDER } from '@/features/Feedback/feedbackCategories';
import { FEEDBACK_CREATE_FIELDS } from '@/features/Feedback/feedbackPayload';
import { readBackendSource } from '@/testing/backendSource';

const modelSource = readBackendSource('src', 'models', 'feedback.py');
const schemaSource = readBackendSource('src', 'schemas', 'feedback.py');

describe('feedback bounds mirror the intake contract', () => {
  it.each([
    ['FEEDBACK_SUMMARY_MAX_LENGTH', bounds.FEEDBACK_SUMMARY_MAX_LENGTH],
    ['FEEDBACK_ANSWER_MAX_LENGTH', bounds.FEEDBACK_ANSWER_MAX_LENGTH],
    ['FEEDBACK_SCREEN_MAX_LENGTH', bounds.FEEDBACK_SCREEN_MAX_LENGTH],
    ['FEEDBACK_CONTROL_MAX_LENGTH', bounds.FEEDBACK_CONTROL_MAX_LENGTH],
    ['FEEDBACK_BUILD_MAX_LENGTH', bounds.FEEDBACK_BUILD_MAX_LENGTH],
    ['FEEDBACK_LOCALE_MAX_LENGTH', bounds.FEEDBACK_LOCALE_MAX_LENGTH],
  ])('%s', (name, clientValue) => {
    expect(clientValue).toBe(pyInt(modelSource, name));
  });

  it('keeps the summary floor at the server min_length of 1', () => {
    expect(schemaSource).toMatch(/summary: str = Field\(\s*min_length=1,/);
    expect(bounds.FEEDBACK_SUMMARY_MIN_LENGTH).toBe(1);
  });

  it.each([
    ['SCREEN_PATTERN', bounds.SCREEN_PATTERN],
    ['CONTROL_PATTERN', bounds.CONTROL_PATTERN],
    ['BUILD_PATTERN', bounds.BUILD_PATTERN],
    ['LOCALE_PATTERN', bounds.LOCALE_PATTERN],
  ])('%s', (name, clientPattern) => {
    expect(clientPattern.source).toBe(pyString(schemaSource, name));
  });

  it('PUBLIC_ID_PATTERN', () => {
    const prefix = pyString(modelSource, 'PUBLIC_ID_PREFIX');
    const alphabet = pyString(modelSource, 'PUBLIC_ID_ALPHABET');
    const length = pyInt(modelSource, 'PUBLIC_ID_BODY_LENGTH');
    expect(FEEDBACK_PUBLIC_ID_PATTERN.source).toBe(`^${prefix}[${alphabet}]{${length}}$`);
  });

  it('category and impact vocabularies', () => {
    expect([...feedbackCategorySchema.options]).toEqual(pyStrEnum(modelSource, 'FeedbackCategory'));
    expect([...feedbackImpactSchema.options]).toEqual(pyStrEnum(modelSource, 'FeedbackImpact'));
    expect([...FEEDBACK_CATEGORY_ORDER]).toEqual(pyStrEnum(modelSource, 'FeedbackCategory'));
  });

  it('the payload can only name fields FeedbackCreate declares', () => {
    const serverFields = pyClassFields(schemaSource, 'FeedbackCreate');
    expect(serverFields).toEqual(
      expect.arrayContaining(['category', 'impact', 'summary', 'intent', 'expected', 'actual']),
    );
    for (const field of FEEDBACK_CREATE_FIELDS) {
      expect(serverFields).toContain(field);
    }
    const typed: ReadonlyArray<keyof FeedbackCreate> = FEEDBACK_CREATE_FIELDS;
    expect(typed.length).toBe(FEEDBACK_CREATE_FIELDS.length);
  });
});
