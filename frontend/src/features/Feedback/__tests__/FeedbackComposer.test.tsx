/* eslint-env jest */
/* global describe, it, expect, jest, beforeEach, afterEach */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, Dimensions, Text } from 'react-native';

import { renderComposer } from './composerHarness';

import * as api from '@/api';
import { ApiError, ApiValidationError, type FeedbackCreate, type FeedbackReceipt } from '@/api';
import { FEEDBACK_CONTEXT_LABELS } from '@/features/Feedback/feedbackCopy';
import {
  FEEDBACK_EDIT_AFTER_FAILURE_COPY,
  FEEDBACK_OUTCOME_COPY,
} from '@/features/Feedback/feedbackOutcome';
import { FEEDBACK_TEST_IDS as IDS } from '@/features/Feedback/feedbackTestIds';
import {
  FEEDBACK_DRAFT_KEY,
  loadFeedbackDraft,
  saveFeedbackDraft,
} from '@/storage/feedbackDraftStorage';
import { _resetSerializedWriteForTests } from '@/storage/serializedWrite';
import { scopedKey, setActiveUser } from '@/storage/userScope';

const RECEIPT: FeedbackReceipt = {
  public_id: 'FB-7K3M9Q2B',
  category: 'broken',
  impact: 'blocked',
  created_at: '2026-09-23T10:00:00Z',
};

const PHONE = { width: 390, height: 844, scale: 1, fontScale: 1 };
const DESKTOP = { width: 1280, height: 720, scale: 1, fontScale: 1 };

let submit: jest.SpyInstance<Promise<FeedbackReceipt>, [FeedbackCreate, string, string?]>;

beforeEach(async () => {
  _resetSerializedWriteForTests();
  setActiveUser(1);
  await AsyncStorage.clear();
  Dimensions.set({ window: PHONE, screen: PHONE });
  submit = jest.spyOn(api.feedback, 'submit');
});

afterEach(() => {
  submit.mockRestore();
  setActiveUser(null);
});

async function openComposer(
  params: Record<string, unknown> = { control: 'shell.header.send_feedback' },
) {
  renderComposer(params);
  await screen.findByTestId(IDS.categoryOption('broken'));
}

function chooseBrokenAndFill(): void {
  fireEvent.press(screen.getByTestId(IDS.categoryOption('broken')));
  fireEvent.changeText(screen.getByTestId(IDS.field('summary')), 'The save button did nothing');
  fireEvent.changeText(screen.getByTestId(IDS.field('intent')), 'Save my page');
  fireEvent.changeText(screen.getByTestId(IDS.field('expected')), 'It saves');
  fireEvent.changeText(screen.getByTestId(IDS.field('actual')), 'Nothing happened');
  fireEvent.press(screen.getByTestId(IDS.impactOption('blocked')));
}

/** The preview's rendered key/value pairs, parsed back out of its rows. */
function renderedPreview(): Record<string, string> {
  const labelToKey = new Map(Object.entries(FEEDBACK_CONTEXT_LABELS).map(([k, v]) => [v, k]));
  const rows = within(screen.getByTestId(IDS.preview))
    .UNSAFE_getAllByType(Text)
    .filter((node) => String(node.props.testID ?? '').startsWith('feedback-attached-'));
  return Object.fromEntries(
    rows.map((node) => {
      const [label = '', ...rest] = String(node.props.children).split(': ');
      return [labelToKey.get(label) ?? label, rest.join(': ')];
    }),
  );
}

function asStrings(context: object): Record<string, string> {
  return Object.fromEntries(Object.entries(context).map(([k, v]) => [k, String(v)]));
}

async function pressSend(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(IDS.send));
  });
}

describe('FeedbackComposerScreen — the single payload seam', () => {
  it('the attached-context preview equals the context passed to feedback.submit', async () => {
    submit.mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();

    const shown = renderedPreview();
    await pressSend();

    expect(submit).toHaveBeenCalledTimes(1);
    const [payload] = submit.mock.calls[0] ?? [];
    expect(shown).toEqual(asStrings(payload?.context ?? {}));
    expect(payload?.context.screen).toBe('journal.shelf');
    expect(payload?.context.control).toBe('shell.header.send_feedback');
    expect(payload?.context.viewport_class).toBe('compact');
  });

  it('says what is NOT included, and how long a report is kept', async () => {
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('idea')));
    const preview = within(screen.getByTestId(IDS.preview));
    expect(preview.getByText(/journal content, passwords, private vault addresses/)).toBeTruthy();
    expect(preview.getByText(/contents of the screen/)).toBeTruthy();
    expect(preview.getByText(/180 days/)).toBeTruthy();
  });
});

describe('FeedbackComposerScreen — the first step', () => {
  it('offers exactly four choices and no text box before one is chosen', async () => {
    await openComposer();

    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual([
      'Something broke',
      'Something was confusing',
      'I have an idea',
      'Something worked well',
    ]);
    expect(screen.queryAllByTestId(/^feedback-field-/)).toHaveLength(0);
    expect(screen.queryByTestId(IDS.send)).toBeNull();
  });

  it('praise asks what to keep and sends not_applicable with no impact question', async () => {
    submit.mockResolvedValue({ ...RECEIPT, category: 'praise', impact: 'not_applicable' });
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('praise')));
    expect(screen.queryByTestId(IDS.impactOption('blocked'))).toBeNull();
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), 'The Map');
    fireEvent.changeText(screen.getByTestId(IDS.field('actual')), 'The calm colours');

    await pressSend();

    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      category: 'praise',
      impact: 'not_applicable',
    });
  });
});

describe('FeedbackComposerScreen — validation', () => {
  it('rejects a whitespace-only summary before any network call, and says so', async () => {
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('idea')));
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), '    ');
    fireEvent.changeText(screen.getByTestId(IDS.field('intent')), 'Write at night');

    await pressSend();

    expect(submit).not.toHaveBeenCalled();
    const error = screen.getByTestId(IDS.fieldError('summary'));
    expect(error.props.accessibilityLiveRegion).toBe('polite');
    expect(error.props.nativeID).toBe(IDS.fieldError('summary'));
    const field = screen.getByTestId(IDS.field('summary'));
    expect(field.props.accessibilityHint).toContain(String(error.props.children));
    expect(screen.getByTestId(IDS.status).props.accessibilityRole).toBe('alert');
  });

  it('gives every field a label and a hint', async () => {
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('broken')));

    const fields = screen.getAllByTestId(/^feedback-field-[a-z]+$/);
    expect(fields).toHaveLength(4);
    for (const field of fields) {
      expect(field.props.accessibilityLabel).toEqual(expect.any(String));
      expect(field.props.accessibilityHint).toEqual(expect.any(String));
    }
  });

  it('never truncates text: nothing caps its lines or opts out of font scaling', async () => {
    Dimensions.set({ window: { ...PHONE, fontScale: 2 }, screen: { ...PHONE, fontScale: 2 } });
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('broken')));

    for (const node of within(screen.getByTestId(IDS.screen)).UNSAFE_getAllByType(Text)) {
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.allowFontScaling).not.toBe(false);
    }
  });
});

describe('FeedbackComposerScreen — one key per draft', () => {
  it('turns a double press into one call, and shows the button busy while in flight', async () => {
    let resolve: (receipt: FeedbackReceipt) => void = () => undefined;
    submit.mockImplementation(
      () =>
        new Promise<FeedbackReceipt>((r) => {
          resolve = r;
        }),
    );
    await openComposer();
    chooseBrokenAndFill();

    // Two presses inside one act: React has not re-rendered the button busy in
    // between, so only the in-flight guard stands between them and two calls.
    act(() => {
      fireEvent.press(screen.getByTestId(IDS.send));
      fireEvent.press(screen.getByTestId(IDS.send));
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(IDS.send).props.accessibilityState).toMatchObject({ busy: true });
    await act(async () => resolve(RECEIPT));
  });

  it('sends under the key persisted with the draft', async () => {
    submit.mockResolvedValue(RECEIPT);
    await openComposer();
    const stored = await loadFeedbackDraft();
    chooseBrokenAndFill();

    await pressSend();

    expect(submit.mock.calls[0]?.[1]).toBe(stored?.idempotencyKey);
  });
});

describe('FeedbackComposerScreen — failures keep the draft', () => {
  it('after a network failure, Send again resends the identical payload under the same key', async () => {
    submit
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();

    await pressSend();

    expect(screen.getByText(FEEDBACK_OUTCOME_COPY.retryable)).toBeTruthy();
    expect(screen.getByText(FEEDBACK_EDIT_AFTER_FAILURE_COPY)).toBeTruthy();
    expect(screen.getByTestId(IDS.field('summary')).props.editable).toBe(false);
    expect((await loadFeedbackDraft())?.attempt).not.toBeNull();

    await pressSend();

    expect(submit).toHaveBeenCalledTimes(2);
    const [first, second] = submit.mock.calls;
    expect(JSON.stringify(second?.[0])).toBe(JSON.stringify(first?.[0]));
    expect(second?.[1]).toBe(first?.[1]);
  });

  it('while frozen, the preview keeps showing the frozen context after the window resizes', async () => {
    submit.mockRejectedValueOnce(new ApiError(503, 'unavailable')).mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();
    await pressSend();

    act(() => {
      Dimensions.set({ window: DESKTOP, screen: DESKTOP });
    });

    expect(renderedPreview().viewport_class).toBe('compact');
    await pressSend();
    expect(submit.mock.calls[1]?.[0].context.viewport_class).toBe('compact');
  });

  it('Edit report discards the frozen attempt and sends under a NEW key', async () => {
    submit.mockRejectedValueOnce(new ApiError(504, 'gateway timeout')).mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();
    await pressSend();

    await act(async () => {
      fireEvent.press(screen.getByTestId(IDS.edit));
    });
    expect(screen.getByTestId(IDS.field('summary')).props.editable).toBe(true);
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), 'Corrected summary');
    await pressSend();

    const [first, second] = submit.mock.calls;
    expect(second?.[1]).not.toBe(first?.[1]);
    expect(second?.[0].summary).toBe('Corrected summary');
  });

  it('a 422 keeps the draft editable under the same key', async () => {
    submit.mockRejectedValueOnce(new ApiError(422, 'validation')).mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();

    await pressSend();

    expect(screen.getByText(FEEDBACK_OUTCOME_COPY.invalid)).toBeTruthy();
    expect(screen.getByTestId(IDS.field('summary')).props.editable).toBe(true);
    expect(screen.queryByTestId(IDS.edit)).toBeNull();
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), 'Shorter');
    await pressSend();
    expect(submit.mock.calls[1]?.[1]).toBe(submit.mock.calls[0]?.[1]);
    expect(submit.mock.calls[1]?.[0].summary).toBe('Shorter');
  });

  it('a 429 says try again later and does not send again on its own', async () => {
    jest.useFakeTimers();
    try {
      submit.mockRejectedValue(new ApiError(429, 'rate limited'));
      await openComposer();
      chooseBrokenAndFill();

      await pressSend();
      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });

      expect(screen.getByText(FEEDBACK_OUTCOME_COPY.rate_limited)).toBeTruthy();
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await loadFeedbackDraft())?.answers.summary).toBe('The save button did nothing');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a 401 says the session ended', async () => {
    submit.mockRejectedValue(new ApiError(401, 'unauthorized'));
    await openComposer();
    chooseBrokenAndFill();

    await pressSend();

    expect(screen.getByText(FEEDBACK_OUTCOME_COPY.session)).toBeTruthy();
  });

  it('a receipt that fails validation keeps (and freezes) the draft', async () => {
    submit.mockRejectedValue(new ApiValidationError('/feedback/', 201, []));
    await openComposer();
    chooseBrokenAndFill();

    await pressSend();

    expect(screen.getByText(FEEDBACK_OUTCOME_COPY.unexpected)).toBeTruthy();
    const stored = await loadFeedbackDraft();
    expect(stored?.answers.summary).toBe('The save button did nothing');
    expect(stored?.attempt).not.toBeNull();
  });
});

describe('FeedbackComposerScreen — success', () => {
  it('announces the FB reference, promises no response time, and only then clears the draft', async () => {
    submit.mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();
    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).not.toBeNull();

    await pressSend();

    const status = screen.getByTestId(IDS.status);
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId(IDS.reference).props.children).toBe('FB-7K3M9Q2B');
    expect(within(status).queryByText(/within|hours|days|soon/i)).toBeNull();
    expect(within(status).getByText(/your report was sent/)).toBeTruthy();
    expect(await AsyncStorage.getItem(scopedKey(FEEDBACK_DRAFT_KEY))).toBeNull();
  });
});

describe('FeedbackComposerScreen — nothing from the screen behind it', () => {
  it('drops prose params: no field is prefilled and control is not attached', async () => {
    submit.mockResolvedValue(RECEIPT);
    await openComposer({ control: 'my_private_note', text: 'my resonance prose', entryId: 7 });

    fireEvent.press(screen.getByTestId(IDS.categoryOption('broken')));
    for (const field of screen.getAllByTestId(/^feedback-field-[a-z]+$/)) {
      expect(field.props.value).toBe('');
    }
    chooseBrokenAndFill();
    await pressSend();

    const [payload] = submit.mock.calls[0] ?? [];
    expect(payload?.context).not.toHaveProperty('control');
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('my resonance prose');
    expect(wire).not.toContain('my_private_note');
    expect(wire).not.toContain('entryId');
    expect(wire).not.toContain('journal prose on screen');
  });

  it('a restored draft — even a frozen one — is never sent without a press', async () => {
    await saveFeedbackDraft({
      category: 'broken',
      impact: 'blocked',
      answers: { summary: 'Restored', intent: 'a', expected: 'b', actual: 'c' },
      idempotencyKey: 'restored-key',
      attempt: {
        key: 'restored-key',
        payload: {
          category: 'broken',
          impact: 'blocked',
          summary: 'Restored',
          context: {
            screen: 'journal.shelf',
            platform: 'ios',
            app_build: '1.0.0',
            viewport_class: 'compact',
          },
        },
      },
    });

    renderComposer({ control: 'shell.header.send_feedback' });
    await screen.findByTestId(IDS.field('summary'));
    await act(async () => undefined);

    expect(screen.getByTestId(IDS.field('summary')).props.value).toBe('Restored');
    expect(screen.getByTestId(IDS.send).props.accessibilityLabel).toBe('Send again');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('FeedbackComposerScreen — focus', () => {
  it('moves screen-reader focus to the composer heading on open', async () => {
    const setFocus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    await openComposer();
    expect(setFocus).toHaveBeenCalledWith(expect.anything(), 'focus');
    setFocus.mockRestore();
  });

  it('marks the heading as a header that can take focus', async () => {
    await openComposer();
    const heading = screen.getByTestId(IDS.heading);
    expect(heading.props.accessibilityRole).toBe('header');
    await waitFor(() => expect(heading.props.tabIndex).toBe(-1));
  });
});

describe('FeedbackComposerScreen — more states', () => {
  it('asks for an impact on a cost category, and names the missing choice', async () => {
    await openComposer();
    fireEvent.press(screen.getByTestId(IDS.categoryOption('broken')));
    fireEvent.changeText(screen.getByTestId(IDS.field('summary')), 's');
    fireEvent.changeText(screen.getByTestId(IDS.field('intent')), 'i');
    fireEvent.changeText(screen.getByTestId(IDS.field('expected')), 'e');
    fireEvent.changeText(screen.getByTestId(IDS.field('actual')), 'a');

    await pressSend();

    expect(submit).not.toHaveBeenCalled();
    const error = screen.getByTestId(IDS.impactError);
    expect(error.props.accessibilityLiveRegion).toBe('polite');
  });

  it('a frozen attempt that fails again stays frozen under the same key', async () => {
    submit.mockRejectedValue(new TypeError('Network request failed'));
    await openComposer();
    chooseBrokenAndFill();

    await pressSend();
    await pressSend();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[1]).toBe(submit.mock.calls[0]?.[1]);
    expect(screen.getByTestId(IDS.edit)).toBeTruthy();
    expect((await loadFeedbackDraft())?.attempt?.key).toBe(submit.mock.calls[0]?.[1]);
  });

  it('Done closes the composer and returns to the screen it was opened over', async () => {
    submit.mockResolvedValue(RECEIPT);
    await openComposer();
    chooseBrokenAndFill();
    await pressSend();

    await act(async () => {
      fireEvent.press(screen.getByTestId(IDS.done));
    });

    await waitFor(() => expect(screen.queryByTestId(IDS.screen)).toBeNull());
    expect(screen.getByText('Journal stub')).toBeTruthy();
  });
});
