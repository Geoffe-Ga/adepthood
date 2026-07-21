/* eslint-env jest */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import SearchBar from '../SearchBar';

import { SPACING, accent } from '@/design/tokens';

describe('SearchBar', () => {
  let onSearch: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    onSearch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders search icon button when collapsed', () => {
    const { getByTestId, queryByTestId, getByText } = render(<SearchBar onSearch={onSearch} />);
    expect(getByTestId('search-toggle')).toBeTruthy();
    expect(queryByTestId('search-input')).toBeNull();
    // Real magnifier glyph, not the old literal "?" placeholder.
    expect(getByText('🔍')).toBeTruthy();
  });

  it('expands to show text input on toggle press', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));
    expect(getByTestId('search-input')).toBeTruthy();
  });

  it('calls onSearch after debounce delay', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));

    const input = getByTestId('search-input');
    fireEvent.changeText(input, 'meditation');

    // Should not have been called yet
    expect(onSearch).not.toHaveBeenCalled();

    // Advance past debounce
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(onSearch).toHaveBeenCalledWith('meditation');
  });

  it('clears search and collapses on clear button press', () => {
    const { getByTestId, queryByTestId } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));

    const input = getByTestId('search-input');
    fireEvent.changeText(input, 'test');

    act(() => {
      jest.advanceTimersByTime(300);
    });

    fireEvent.press(getByTestId('search-clear'));

    expect(onSearch).toHaveBeenLastCalledWith('');
    expect(queryByTestId('search-input')).toBeNull();
  });

  it('debounces rapid typing', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));

    const input = getByTestId('search-input');
    fireEvent.changeText(input, 'm');
    fireEvent.changeText(input, 'me');
    fireEvent.changeText(input, 'med');

    act(() => {
      jest.advanceTimersByTime(300);
    });

    // Only called once with the final value
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('med');
  });

  it('shows result count when provided', () => {
    const { getByTestId, getByText } = render(
      <SearchBar onSearch={onSearch} resultCount={5} searchQuery="test" />,
    );
    fireEvent.press(getByTestId('search-toggle'));
    expect(getByText("5 results for 'test'")).toBeTruthy();
  });

  it('uses the singular noun for exactly one result', () => {
    const { getByTestId, getByText } = render(
      <SearchBar onSearch={onSearch} resultCount={1} searchQuery="test" />,
    );
    fireEvent.press(getByTestId('search-toggle'));
    expect(getByText("1 result for 'test'")).toBeTruthy();
  });

  it('shows a "No results" line when a query comes back empty', () => {
    const { getByTestId, getByText } = render(
      <SearchBar onSearch={onSearch} resultCount={0} searchQuery="willow" />,
    );
    fireEvent.press(getByTestId('search-toggle'));
    expect(getByText("No results for 'willow'")).toBeTruthy();
  });

  it('applies the accent focus border on focus and reverts it on blur', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));
    const input = getByTestId('search-input');

    expect(StyleSheet.flatten(input.props.style).borderColor).not.toBe(accent.primary);

    fireEvent(input, 'focus');
    expect(StyleSheet.flatten(input.props.style).borderColor).toBe(accent.primary);

    fireEvent(input, 'blur');
    expect(StyleSheet.flatten(input.props.style).borderColor).not.toBe(accent.primary);
  });

  it('syncs the input text when the parent resets searchQuery externally', () => {
    const { getByTestId, rerender } = render(
      <SearchBar onSearch={onSearch} searchQuery="willow" />,
    );
    expect(getByTestId('search-input').props.value).toBe('willow');

    rerender(<SearchBar onSearch={onSearch} searchQuery="" />);
    expect(getByTestId('search-input').props.value).toBe('');
  });

  it('sits the collapsed toggle on the 8px base grid with a top nudge', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} />);
    const bar = StyleSheet.flatten(getByTestId('search-bar-collapsed').props.style);
    expect(bar.paddingTop).toBe(SPACING.sm);
    expect(bar.paddingBottom).toBe(SPACING.xs);
    expect(bar.paddingVertical).toBeUndefined();
  });

  it('keeps the expanded bar on the same rhythm as the collapsed one', () => {
    const { getByTestId } = render(<SearchBar onSearch={onSearch} searchQuery="willow" />);
    const bar = StyleSheet.flatten(getByTestId('search-bar-expanded').props.style);
    expect(bar.paddingTop).toBe(SPACING.sm);
    expect(bar.paddingBottom).toBe(SPACING.xs);
    expect(bar.paddingVertical).toBeUndefined();
  });

  it('clears a pending debounce timer on unmount without ever calling onSearch', () => {
    const { getByTestId, unmount } = render(<SearchBar onSearch={onSearch} />);
    fireEvent.press(getByTestId('search-toggle'));
    fireEvent.changeText(getByTestId('search-input'), 'partial query');

    unmount();

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(onSearch).not.toHaveBeenCalled();
  });
});
