/* eslint-env jest */
/* global describe, it, expect, jest, beforeEach, afterEach */
import { AccessibilityInfo, Platform, type View } from 'react-native';

import {
  focusHost,
  rememberFeedbackOrigin,
  restoreFeedbackOrigin,
} from '@/features/Feedback/feedbackFocus';
import { openFeedbackComposer } from '@/features/Feedback/navigation';

function refTo(host: View | null): { current: View | null } {
  return { current: host };
}

const host = {} as View;
let sendEvent: jest.SpyInstance;

beforeEach(() => {
  sendEvent = jest
    .spyOn(AccessibilityInfo, 'sendAccessibilityEvent')
    .mockImplementation(() => undefined);
  rememberFeedbackOrigin(null);
});

afterEach(() => {
  sendEvent.mockRestore();
});

describe('feedback focus return', () => {
  it('returns focus to the control that opened the composer, once', () => {
    rememberFeedbackOrigin(refTo(host));

    restoreFeedbackOrigin();
    restoreFeedbackOrigin();

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith(host, 'focus');
  });

  it('is a no-op when the remembered control has unmounted', () => {
    rememberFeedbackOrigin(refTo(null));
    restoreFeedbackOrigin();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing was remembered (the composer opened some other way)', () => {
    restoreFeedbackOrigin();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('openFeedbackComposer remembers the origin and navigates with only the token', () => {
    const navigate = jest.fn();
    openFeedbackComposer({ navigate }, 'shell.header.send_feedback', refTo(host));

    expect(navigate).toHaveBeenCalledWith('Feedback', { control: 'shell.header.send_feedback' });
    restoreFeedbackOrigin();
    expect(sendEvent).toHaveBeenCalledWith(host, 'focus');
  });

  it('openFeedbackComposer with no origin clears a stale one', () => {
    rememberFeedbackOrigin(refTo(host));
    openFeedbackComposer({ navigate: jest.fn() }, 'settings.row.send_feedback');
    restoreFeedbackOrigin();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('on the web, calls the DOM node’s own focus()', () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      const focus = jest.fn();
      focusHost({ focus } as unknown as View);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(sendEvent).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
