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
import { readBackendSource, REPO_ROOT } from '@/testing/backendSource';

const POLICY = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'legal', 'privacy-policy.md'), 'utf-8');

/**
 * How long the backend keeps a report, read from the Python that sweeps it
 * rather than restated here: the copy and the policy must follow the backend,
 * and reading through `@/testing/backendSource` is what makes `backend-ci.yml`
 * run this file on the backend change that would break it.
 */
const BACKEND_MODEL = ['src', 'models', 'feedback.py'];
const RETENTION = /^FEEDBACK_RETENTION_DAYS: Final = (\d+)$/m;

function backendRetentionDays(): string {
  const match = RETENTION.exec(readBackendSource(...BACKEND_MODEL));
  if (match === null) {
    throw new Error(`FEEDBACK_RETENTION_DAYS not found in backend/${BACKEND_MODEL.join('/')}`);
  }
  return match[1] ?? '';
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[*`]/g, '').split(/\s+/).join(' ');
}

const section = (() => {
  const start = POLICY.indexOf('## Beta feedback');
  const end = POLICY.indexOf('\n## ', start + 1);
  if (start === -1) throw new Error('privacy policy has no "## Beta feedback" section');
  return normalise(POLICY.slice(start, end === -1 ? undefined : end));
})();

/** The policy's own bolded name for each of the seven context keys. */
const POLICY_TERM_BY_KEY = {
  screen: 'canonical screen',
  control: 'control',
  platform: 'platform',
  app_build: 'app build',
  viewport_class: 'viewport class',
  locale: 'locale',
  correlation_id: 'correlation id',
} as const;

/**
 * The bolded field names in the policy's "What the app attaches" list: every
 * `**...**` span between "Seven fields, and no eighth" and "That list is an
 * allowlist". Bare words like "screen" and "control" also appear elsewhere in
 * the section, so only the bolded list entries count.
 */
function policyFieldTerms(markdown: string): Set<string> {
  const start = markdown.indexOf('Seven fields, and no eighth');
  const end = markdown.indexOf('That list is an allowlist', start);
  if (start === -1 || end === -1) throw new Error('policy field list not found');
  const list = markdown.slice(start, end);
  return new Set(
    [...list.matchAll(/\*\*([^*]+)\*\*/g)]
      .map((m) => (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((term) => term !== 'what the app attaches.'),
  );
}

describe('preview copy agrees with the privacy policy', () => {
  it('lists, in bold, exactly the seven fields the preview can show (review [5])', () => {
    const terms = policyFieldTerms(POLICY);
    expect(terms).toEqual(new Set(Object.values(POLICY_TERM_BY_KEY)));
    expect(Object.keys(POLICY_TERM_BY_KEY).sort()).toEqual(
      Object.keys(FEEDBACK_CONTEXT_LABELS).sort(),
    );
    for (const [key, label] of Object.entries(FEEDBACK_CONTEXT_LABELS)) {
      // The preview's label is the policy's own word for the field.
      expect(POLICY_TERM_BY_KEY[key as keyof typeof POLICY_TERM_BY_KEY]).toContain(
        label.toLowerCase(),
      );
    }
    expect(section).toContain('seven fields, and no eighth');
  });

  it('fails when the policy drops a field, even one named by a common word', () => {
    const withoutScreen = POLICY.replace('**canonical screen**', 'canonical screen');
    expect(policyFieldTerms(withoutScreen)).not.toContain('canonical screen');
    const withoutControl = POLICY.replace('**control**', 'control');
    expect(policyFieldTerms(withoutControl)).not.toContain('control');
  });

  it('states the retention the backend enforces', () => {
    const days = /(\d+) days/.exec(FEEDBACK_PREVIEW_COPY.retention)?.[1];
    expect(days).toBe(backendRetentionDays());
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
