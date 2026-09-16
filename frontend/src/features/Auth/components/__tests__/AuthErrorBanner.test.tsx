/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import { AuthErrorBanner } from '../AuthErrorBanner';

const TEST_ID = 'login-error';

describe('AuthErrorBanner', () => {
  it('renders nothing when the message is null', () => {
    const { queryByTestId, toJSON } = render(<AuthErrorBanner message={null} testID={TEST_ID} />);

    expect(queryByTestId(TEST_ID)).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('announces the message as an alert in a polite live region', () => {
    const { getByTestId } = render(
      <AuthErrorBanner message="Enter your email to continue." testID={TEST_ID} />,
    );

    const banner = getByTestId(TEST_ID);
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner).toHaveTextContent('Enter your email to continue.');
  });
});
