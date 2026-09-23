/* eslint-env jest */
/* global describe, it, expect */
/**
 * AC22: the composer's "What will be attached" copy and the privacy policy's
 * Beta feedback section describe the same seven fields, the same exclusions and
 * the same retention -- and the correlation id the policy says the app "may"
 * send is one this client deliberately does not (decision D1).
 */
import * as fs from 'fs';
import * as path from 'path';

import { buildFeedbackContext } from '@/features/Feedback/feedbackContext';
import { FEEDBACK_CONTEXT_LABELS, FEEDBACK_PREVIEW_COPY } from '@/features/Feedback/feedbackCopy';
import { REPO_ROOT } from '@/testing/backendSource';

const POLICY = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'legal', 'privacy-policy.md'), 'utf-8');

function normalise(text: string): string {
  return text.toLowerCase().replace(/[*`]/g, '').split(/\s+/).join(' ');
}

const section = (() => {
  const start = POLICY.indexOf('## Beta feedback');
  const end = POLICY.indexOf('\n## ', start + 1);
  if (start === -1) throw new Error('privacy policy has no "## Beta feedback" section');
  return normalise(POLICY.slice(start, end === -1 ? undefined : end));
})();

describe('preview copy agrees with the privacy policy', () => {
  it('names each of the seven fields the policy lists', () => {
    const labels = Object.values(FEEDBACK_CONTEXT_LABELS);
    expect(labels).toHaveLength(7);
    for (const label of labels) {
      expect(section).toContain(label.toLowerCase());
    }
    expect(section).toContain('seven fields, and no eighth');
  });

  it('states the same retention', () => {
    const days = /(\d+) days/.exec(FEEDBACK_PREVIEW_COPY.retention)?.[1];
    expect(days).toBe('180');
    expect(section).toContain(`kept for ${days} days`);
  });

  it('excludes what the policy says is never attached', () => {
    const notIncluded = normalise(FEEDBACK_PREVIEW_COPY.notIncluded);
    expect(notIncluded).toContain('contents of the screen');
    expect(section).toContain('contents of the screen');
    expect(notIncluded).toContain('vault addresses');
    expect(section).toContain('vault address');
    expect(notIncluded).toContain('journal content');
    expect(notIncluded).toContain('passwords');
  });

  it('only says the correlation id "may" be sent, and this client sends none', () => {
    expect(section).toContain('the app may send');
    const context = buildFeedbackContext({
      routeName: 'Journal',
      control: undefined,
      width: 390,
      os: 'ios',
      locale: 'en-US',
      appBuild: '1.0.0',
    });
    expect(context).not.toHaveProperty('correlation_id');
  });
});
