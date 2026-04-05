/* eslint-env jest */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, fireEvent, act } from '@testing-library/react-native';
import React from 'react';

import SearchBar from '../SearchBar';

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
    const { getByTestId, queryByTestId } = render(<SearchBar onSearch={onSearch} />);
    expect(getByTestId('search-toggle')).toBeTruthy();
    expect(queryByTestId('search-input')).toBeNull();
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
});
