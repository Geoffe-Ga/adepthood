/**
 * The captured-transcript store is the hand-off seam between the photograph
 * capture route and the journal entry that asked for the page. It carries the
 * transcribed prose one hop, in memory only: the writing never rides in
 * navigation params, and the registry reset wipes it at logout so the next
 * person on the device cannot inherit an undelivered page.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import { resetAllStores } from '../registry';
import { useCapturedTranscriptStore } from '../useCapturedTranscriptStore';

const state = () => useCapturedTranscriptStore.getState();

/** Open a hand-off and return its token, the way the entry screen does. */
function open(): string {
  let token = '';
  act(() => {
    token = state().open();
  });
  return token;
}

beforeEach(() => {
  act(() => {
    state().clear();
  });
});

describe('useCapturedTranscriptStore', () => {
  it('starts with nothing pending', () => {
    expect(state().pending).toBeNull();
  });

  it('mints a fresh token for every hand-off it opens', () => {
    expect(open()).not.toBe(open());
  });

  it('publishes a delivered transcript under the token it was addressed to', () => {
    const token = open();

    act(() => {
      state().deliver(token, 'A page in my own hand.');
    });

    expect(state().pending).toEqual({ token, text: 'A page in my own hand.' });
  });

  it('clear retracts a pending transcript so it is delivered exactly once', () => {
    const token = open();
    act(() => {
      state().deliver(token, 'Read once.');
    });

    act(() => {
      state().clear();
    });

    expect(state().pending).toBeNull();
  });

  it('opening a fresh hand-off drops a transcript the last one never collected', () => {
    const stale = open();
    act(() => {
      state().deliver(stale, 'Never collected.');
    });

    open();

    expect(state().pending).toBeNull();
  });

  it('registers its reset with the shared registry so logout wipes it', () => {
    const token = open();
    act(() => {
      state().deliver(token, 'Private prose.');
    });
    expect(state().pending).not.toBeNull();

    act(() => {
      resetAllStores();
    });

    expect(state().pending).toBeNull();
  });
});
