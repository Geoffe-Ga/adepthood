/* eslint-env jest */
/* global describe, it, expect, jest, afterEach */
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { Dimensions, Platform, TouchableOpacity, View } from 'react-native';

import { RadioGroup, RadioOption } from '@/components/RadioOption';
import { CategoryStep } from '@/features/Feedback/components/CategoryStep';
import { ImpactPicker } from '@/features/Feedback/components/ImpactPicker';
import {
  FEEDBACK_CATEGORY_CONFIG,
  FEEDBACK_CATEGORY_ORDER,
} from '@/features/Feedback/feedbackCategories';
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
    expect(input.props['aria-describedby']).toContain(IDS.fieldError('summary'));
    expect(input.props['aria-invalid']).toBe(true);
    expect(screen.getByTestId(IDS.fieldError('summary')).props.nativeID).toBe(
      IDS.fieldError('summary'),
    );
  });

  it('describes the input by its hint when there is no error (review [14])', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    renderField();
    const input = screen.getByTestId(IDS.field('summary'));
    expect(input.props['aria-describedby']).toBe(IDS.fieldHint('summary'));
    expect(input.props['aria-invalid']).toBeUndefined();
    expect(screen.getByText('A short line.').props.nativeID).toBe(IDS.fieldHint('summary'));
  });

  it('describes the input by its hint AND its error once there is one', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    renderField('This one is needed.');
    expect(screen.getByTestId(IDS.field('summary')).props['aria-describedby']).toBe(
      `${IDS.fieldHint('summary')} ${IDS.fieldError('summary')}`,
    );
  });
});

/** The radiogroup container (a plain View, so not reachable by role). */
function radioGroup(): { props: Record<string, unknown> } {
  const group = screen
    .UNSAFE_getAllByType(View)
    .find((node) => node.props.accessibilityRole === 'radiogroup');
  if (group === undefined) throw new Error('no radiogroup rendered');
  return group;
}

describe('radios on the web (review [14])', () => {
  const original = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  it('expose checked and disabled state, and a locked option cannot be pressed', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const onPress = jest.fn();
    render(
      <RadioOption
        label="Something broke"
        selected
        disabled
        onPress={onPress}
        testID="opt"
        style={{}}
        selectedStyle={{}}
        labelStyle={{}}
        selectedLabelStyle={{}}
      />,
    );
    // React Native's own Touchable consumes these props; react-native-web writes
    // them to the DOM. Read them where both see them: on the touchable itself.
    const touchable = screen.UNSAFE_getByType(TouchableOpacity);
    expect(touchable.props['aria-checked']).toBe(true);
    expect(touchable.props['aria-disabled']).toBe(true);
    expect(touchable.props.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('opt'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('link an option and a group to the text that describes them, on the web only', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    render(
      <RadioGroup style={{}} accessibilityLabel="Impact" describedBy="impact-error">
        <RadioOption
          label="It stopped me"
          selected={false}
          onPress={jest.fn()}
          testID="opt"
          describedBy="opt-description"
          style={{}}
          selectedStyle={{}}
          labelStyle={{}}
          selectedLabelStyle={{}}
        />
      </RadioGroup>,
    );
    expect(screen.UNSAFE_getByType(TouchableOpacity).props['aria-describedby']).toBe(
      'opt-description',
    );
    expect(radioGroup().props['aria-describedby']).toBe('impact-error');
  });
});

describe('the composer on the web (review [14])', () => {
  it('shows each category’s description as text, not only as a hint', () => {
    render(<CategoryStep selected={null} onSelect={jest.fn()} disabled={false} />);
    for (const category of FEEDBACK_CATEGORY_ORDER) {
      const description = screen.getByText(FEEDBACK_CATEGORY_CONFIG[category].description);
      expect(description.props.nativeID).toBe(IDS.categoryDescription(category));
    }
  });

  it('describes each option by the hint that lives inside it, on the web (#2951)', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      render(<CategoryStep selected={null} onSelect={jest.fn()} disabled={false} />);
      for (const category of FEEDBACK_CATEGORY_ORDER) {
        const { description } = FEEDBACK_CATEGORY_CONFIG[category];
        const option = screen.getByTestId(IDS.categoryOption(category));
        // RN's Touchable consumes aria-* before the host; read it on the touchable.
        const touchable = screen
          .UNSAFE_getAllByType(TouchableOpacity)
          .find((node) => node.props.testID === IDS.categoryOption(category));
        expect(touchable?.props['aria-describedby']).toBe(IDS.categoryDescription(category));
        expect(within(option).getByText(description).props.nativeID).toBe(
          IDS.categoryDescription(category),
        );
        expect(option.props.accessibilityHint).toBe(description);
      }
    } finally {
      Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    }
  });

  it('keeps the label as the only accessible name of each option (#2951)', () => {
    render(<CategoryStep selected={null} onSelect={jest.fn()} disabled={false} />);
    for (const category of FEEDBACK_CATEGORY_ORDER) {
      const option = screen.getByRole('radio', { name: FEEDBACK_CATEGORY_CONFIG[category].label });
      expect(option.props.testID).toBe(IDS.categoryOption(category));
    }
  });

  it('links the impact error to the impact choices', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      render(
        <ImpactPicker
          choices={['blocked', 'can_continue']}
          selected={null}
          onSelect={jest.fn()}
          disabled={false}
          error="Choose how much this affected you."
        />,
      );
      expect(radioGroup().props['aria-describedby']).toBe(IDS.impactError);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    }
  });
});
