/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { SOURCE_LABEL_COPY, sourceLabel } from '../sourceLabel';

describe('sourceLabel', () => {
  it.each([undefined, null, 'local', 'creek_vault ', 'CREEK_VAULT', 42, {}, [], true])(
    'reads %p as "Source not recorded" -- never a guess',
    (value) => {
      expect(sourceLabel(value)).toBe(SOURCE_LABEL_COPY.notRecorded);
      expect(SOURCE_LABEL_COPY.notRecorded).toBe('Source not recorded');
    },
  );

  it('labels the stub as an unmistakable demo', () => {
    expect(sourceLabel('demo')).toMatch(/^Demo/);
    expect(sourceLabel('demo')).toMatch(/not a real reflection/);
  });

  it('labels each recorded source with its own copy', () => {
    expect(sourceLabel('creek_vault')).toBe(SOURCE_LABEL_COPY.creekVault);
    expect(sourceLabel('app_provider')).toBe(SOURCE_LABEL_COPY.appProvider);
    expect(sourceLabel('none')).toBe(SOURCE_LABEL_COPY.notRun);
    const distinct = new Set(
      ['creek_vault', 'app_provider', 'demo', 'none', null].map((v) => sourceLabel(v)),
    );
    expect(distinct.size).toBe(5);
  });

  it('makes no locality, privacy or vendor claim in any label', () => {
    for (const copy of Object.values(SOURCE_LABEL_COPY)) {
      expect(copy).not.toMatch(/local|private|in your vault|on your device|anthropic|openai/i);
    }
  });
});
