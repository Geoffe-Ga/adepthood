import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import DrawerSearch from '@/components/drawer/DrawerSearch';
import { INTERACTIVE_TEXT_MIN, accent, ink, radius, surface } from '@/design/tokens';

const DEBOUNCE_MS = 300;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('DrawerSearch debounce', () => {
  it('emits nothing before the debounce elapses, then the typed text once after 300ms', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith('ritual');
  });

  it('coalesces rapid successive keystrokes into a single debounced emission', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);
    const input = getByTestId('drawer-search-input');

    fireEvent.changeText(input, 'r');
    fireEvent.changeText(input, 'ri');
    fireEvent.changeText(input, 'rit');
    fireEvent.changeText(input, 'ritu');

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith('ritu');
  });

  it('emits an empty string after debounce when the field is cleared', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);
    const input = getByTestId('drawer-search-input');

    fireEvent.changeText(input, 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    onQueryChange.mockClear();

    fireEvent.changeText(input, '');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('clears the pending debounce timer on unmount and never calls onQueryChange', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, unmount } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'partial query');
    unmount();

    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(onQueryChange).not.toHaveBeenCalled();
  });
});

describe('DrawerSearch result caption', () => {
  it('is hidden when no query has been entered, even with a resultCount', () => {
    const onQueryChange = jest.fn();
    const { queryByTestId } = render(
      <DrawerSearch onQueryChange={onQueryChange} resultCount={5} />,
    );

    expect(queryByTestId('drawer-search-result-count')).toBeNull();
  });

  it('is hidden when resultCount is undefined even with an active query', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, queryByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(queryByTestId('drawer-search-result-count')).toBeNull();
  });

  it('shows a "No results" caption for a zero count', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, rerender } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    rerender(<DrawerSearch onQueryChange={onQueryChange} resultCount={0} />);

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('No results');
  });

  it('uses the singular noun for exactly one result', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, rerender } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    rerender(<DrawerSearch onQueryChange={onQueryChange} resultCount={1} />);

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('1 result');
  });

  it('uses the plural noun for multiple results', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, rerender } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    rerender(<DrawerSearch onQueryChange={onQueryChange} resultCount={3} />);

    expect(getByTestId('drawer-search-result-count')).toHaveTextContent('3 results');
  });

  it('renders the caption color as the muted ink token', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, rerender } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    rerender(<DrawerSearch onQueryChange={onQueryChange} resultCount={3} />);

    const caption = getByTestId('drawer-search-result-count');
    const flatStyle = StyleSheet.flatten(caption.props.style) as { color?: string };
    expect(flatStyle.color).toBe(ink.muted);
  });
});

describe('DrawerSearch deep-search confirm row', () => {
  it('is absent when onConfirmDeepSearch is not passed', () => {
    const onQueryChange = jest.fn();
    const { getByTestId, queryByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(queryByTestId('drawer-search-deep-search')).toBeNull();
  });

  it('is absent when onConfirmDeepSearch is passed but no query has been typed', () => {
    const onQueryChange = jest.fn();
    const onConfirmDeepSearch = jest.fn();
    const { queryByTestId } = render(
      <DrawerSearch
        onQueryChange={onQueryChange}
        onConfirmDeepSearch={onConfirmDeepSearch}
        deepSearchLabel="Search all entries"
      />,
    );

    expect(queryByTestId('drawer-search-deep-search')).toBeNull();
  });

  it('appears with the exact deepSearchLabel once a non-empty query is active, and fires onConfirmDeepSearch without onQueryChange', () => {
    const onQueryChange = jest.fn();
    const onConfirmDeepSearch = jest.fn();
    const { getByTestId, getByText } = render(
      <DrawerSearch
        onQueryChange={onQueryChange}
        onConfirmDeepSearch={onConfirmDeepSearch}
        deepSearchLabel="Search all entries"
      />,
    );

    fireEvent.changeText(getByTestId('drawer-search-input'), 'ritual');
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(getByText('Search all entries')).toBeTruthy();
    onQueryChange.mockClear();

    fireEvent.press(getByTestId('drawer-search-deep-search'));

    expect(onConfirmDeepSearch).toHaveBeenCalledTimes(1);
    expect(onQueryChange).not.toHaveBeenCalled();
  });
});

describe('DrawerSearch placeholder and accessibility label', () => {
  it('defaults the placeholder to "Search..."', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    expect(getByTestId('drawer-search-input').props.placeholder).toBe('Search...');
  });

  it('overrides the placeholder when one is given', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(
      <DrawerSearch onQueryChange={onQueryChange} placeholder="Find a reflection" />,
    );

    expect(getByTestId('drawer-search-input').props.placeholder).toBe('Find a reflection');
  });

  it('defaults the accessibility label to "Search"', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    expect(getByTestId('drawer-search-input').props.accessibilityLabel).toBe('Search');
  });

  it('overrides the accessibility label when one is given', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(
      <DrawerSearch onQueryChange={onQueryChange} accessibilityLabel="Search this drawer" />,
    );

    expect(getByTestId('drawer-search-input').props.accessibilityLabel).toBe('Search this drawer');
  });
});

describe('DrawerSearch input styling', () => {
  it('applies the interactive text floor, raised surface, and large radius to the input', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);

    const flatStyle = StyleSheet.flatten(getByTestId('drawer-search-input').props.style) as {
      fontSize?: number;
      backgroundColor?: string;
      borderRadius?: number;
    };

    expect(flatStyle.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    expect(flatStyle.backgroundColor).toBe(surface.raised);
    expect(flatStyle.borderRadius).toBe(radius.lg);
  });

  it('turns the border to the accent color on focus and reverts it on blur', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = render(<DrawerSearch onQueryChange={onQueryChange} />);
    const input = getByTestId('drawer-search-input');

    expect(StyleSheet.flatten(input.props.style).borderColor).not.toBe(accent.primary);

    fireEvent(input, 'focus');
    expect(StyleSheet.flatten(input.props.style).borderColor).toBe(accent.primary);

    fireEvent(input, 'blur');
    expect(StyleSheet.flatten(input.props.style).borderColor).not.toBe(accent.primary);
  });
});
