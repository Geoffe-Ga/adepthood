import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import { TitleHost } from '../TitleHost';

/**
 * The in-body stand-in for a screen title the stack header already paints
 * (#2962): a header announced by the title, drawing nothing, owning nothing,
 * and never a focus target.
 */
describe('TitleHost', () => {
  it('is one header named by the title that paints no text', () => {
    const { getAllByRole, queryByText } = render(<TitleHost title="Time zone" />);
    const headers = getAllByRole('header', { name: 'Time zone' });
    expect(headers).toHaveLength(1);
    expect(queryByText('Time zone')).toBeNull();
  });

  it('wraps nothing and carries no hint, so the text beside it reads on its own', () => {
    const { getByRole } = render(<TitleHost title="Time zone" />);
    const host = getByRole('header', { name: 'Time zone' });
    expect(host.props.children).toBeUndefined();
    expect(host.props.accessibilityHint).toBeUndefined();
  });

  it('is never a focus target: no tabIndex, not focusable', () => {
    const { getByRole } = render(<TitleHost title="Time zone" />);
    const host = getByRole('header', { name: 'Time zone' });
    expect(host.props.tabIndex).toBeUndefined();
    expect(host.props.focusable).toBeUndefined();
  });

  it('forwards its testID', () => {
    const { getByTestId } = render(<TitleHost title="Time zone" testID="tz-title" />);
    expect(getByTestId('tz-title').props.accessibilityLabel).toBe('Time zone');
  });
});
