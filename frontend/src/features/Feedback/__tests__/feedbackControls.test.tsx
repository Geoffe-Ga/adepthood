/* eslint-env jest */
/* global describe, it, expect, jest, afterEach */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, Platform } from 'react-native';

import { FeedbackField } from '@/features/Feedback/FeedbackField';
import { FEEDBACK_TEST_IDS as IDS } from '@/features/Feedback/feedbackTestIds';
import { SendFeedbackButton } from '@/features/Feedback/SendFeedbackButton';

const PHONE = { width: 390, height: 844, scale: 1, fontScale: 1 };
const DESKTOP = { width: 1280, height: 720, scale: 1, fontScale: 1 };

afterEach(() => {
  Dimensions.set({ window: PHONE, screen: PHONE });
});

describe('SendFeedbackButton', () => {
  it('reads "Send feedback" on a wide window', () => {
    Dimensions.set({ window: DESKTOP, screen: DESKTOP });
    render(<SendFeedbackButton onPress={jest.fn()} />);
    expect(screen.getByText('Send feedback')).toBeTruthy();
  });

  it('shortens its visible label on a phone but keeps its accessible name', () => {
    Dimensions.set({ window: PHONE, screen: PHONE });
    render(<SendFeedbackButton onPress={jest.fn()} />);
    expect(screen.getByText('Feedback')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeTruthy();
  });

  it('hands its own ref to the caller when pressed', () => {
    const onPress = jest.fn();
    render(<SendFeedbackButton onPress={onPress} />);
    fireEvent.press(screen.getByTestId(IDS.headerButton));
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ current: expect.anything() }));
  });
});

describe('FeedbackField on the web', () => {
  const original = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  function renderField(error?: string) {
    return render(
      <FeedbackField
        field="summary"
        label="In one sentence, what broke?"
        hint="A short line."
        value=""
        onChangeText={jest.fn()}
        maxLength={280}
        multiline={false}
        editable
        error={error}
      />,
    );
  }

  it('points the input at its error with aria-describedby', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    renderField('This one is needed.');
    const input = screen.getByTestId(IDS.field('summary'));
    expect(input.props['aria-describedby']).toBe(IDS.fieldError('summary'));
    expect(input.props['aria-invalid']).toBe(true);
    expect(screen.getByTestId(IDS.fieldError('summary')).props.nativeID).toBe(
      IDS.fieldError('summary'),
    );
  });

  it('carries no describedby while there is no error', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    renderField();
    expect(screen.getByTestId(IDS.field('summary')).props['aria-describedby']).toBeUndefined();
  });
});
