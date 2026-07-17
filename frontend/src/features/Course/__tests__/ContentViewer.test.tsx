/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import type { ContentItem } from '../../../api';
import type { ChapterNav } from '../chapterNav';
import ContentViewer from '../ContentViewer';

jest.mock('../../../api', () => ({
  course: {
    markRead: jest.fn(),
    contentBody: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    markRead: jest.MockedFunction<typeof Api.course.markRead>;
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
  };
};

const HAPPY_BODY = {
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: '# Chapter One\n\nHi.\n',
};

const HAPPY_COMPLETION = {
  id: 1,
  user_id: 1,
  content_id: 1,
  completed_at: '2026-01-15T10:00:00Z',
};

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 1,
    title: 'Test Article',
    content_type: 'chapter',
    release_day: 0,
    url: 'content://beige-1',
    is_locked: false,
    is_read: false,
    ...overrides,
  };
}

function makeNav(overrides: Partial<ChapterNav> = {}): ChapterNav {
  return {
    canPrev: true,
    nextIsDone: false,
    onPrev: jest.fn(),
    onNext: jest.fn(),
    ...overrides,
  };
}

describe('ContentViewer', () => {
  let onBack: jest.Mock;
  let onMarkRead: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    onBack = jest.fn();
    onMarkRead = jest.fn();
    courseApi.markRead.mockResolvedValue(HAPPY_COMPLETION);
    courseApi.contentBody.mockResolvedValue(HAPPY_BODY);
  });

  it('renders the content title initially, then swaps to the live title', async () => {
    const item = makeItem({ title: 'Loading Title' });
    const { getByText, findAllByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    expect(getByText('Loading Title')).toBeTruthy();
    await findAllByText('Chapter One');
  });

  it('fetches the content body via the API', async () => {
    const item = makeItem();
    render(<ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />);
    await waitFor(() => {
      expect(courseApi.contentBody).toHaveBeenCalledWith(item.id);
    });
  });

  it('renders the body as native Markdown', async () => {
    const item = makeItem();
    const { findByTestId, findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    await findByText('Hi.');
  });

  it('calls onBack when back button is pressed', async () => {
    const item = makeItem();
    const { getByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    // Wait until the load settles so we don't hit "state update on unmounted".
    await findByTestId('reader-markdown');
    fireEvent.press(getByTestId('reader-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('marks content as read when the button is pressed', async () => {
    const item = makeItem();
    const { getByTestId, getByText, findAllByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findAllByText('Chapter One');
    expect(getByText('Mark as Read')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });

    await waitFor(() => {
      expect(courseApi.markRead).toHaveBeenCalledWith(1);
      expect(onMarkRead).toHaveBeenCalledTimes(1);
      expect(getByText('✓ Read')).toBeTruthy();
    });
  });

  it('shows already-read state when item is pre-read', async () => {
    const item = makeItem({ is_read: true });
    const { getByText, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(getByText('✓ Read')).toBeTruthy();
  });

  it('disables mark-read when already read', async () => {
    const item = makeItem({ is_read: true });
    const { getByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    fireEvent.press(getByTestId('mark-read-button'));
    expect(courseApi.markRead).not.toHaveBeenCalled();
  });

  it('shows the reflect button when the item is read', async () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn();
    const { getByTestId, getByText, findByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        onReflect={onReflect}
        nav={makeNav()}
      />,
    );
    await findByTestId('reader-markdown');
    expect(getByTestId('reflect-button')).toBeTruthy();
    expect(getByText('Reflect in Journal')).toBeTruthy();
  });

  it('shows the reflect button after marking content as read', async () => {
    const item = makeItem({ is_read: false });
    const onReflect = jest.fn();
    const { getByTestId, queryByTestId, findByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        onReflect={onReflect}
        nav={makeNav()}
      />,
    );
    await findByTestId('reader-markdown');
    expect(queryByTestId('reflect-button')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });

    await waitFor(() => {
      expect(getByTestId('reflect-button')).toBeTruthy();
    });
  });

  it('calls onReflect when the reflect button is pressed', async () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn();
    const { getByTestId, findByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        onReflect={onReflect}
        nav={makeNav()}
      />,
    );
    await findByTestId('reader-markdown');
    fireEvent.press(getByTestId('reflect-button'));
    expect(onReflect).toHaveBeenCalledTimes(1);
  });

  it('omits the reflect button when no callback is provided', async () => {
    const item = makeItem({ is_read: true });
    const { queryByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(queryByTestId('reflect-button')).toBeNull();
  });

  it('does not refetch the body when marking as read', async () => {
    const item = makeItem();
    const { getByTestId, queryByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(courseApi.contentBody).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });
    await waitFor(() => {
      expect(onMarkRead).toHaveBeenCalledTimes(1);
    });

    // The mark-as-read re-render passes a fresh ``source`` literal; the reader
    // must key its fetch on the primitive identity, so the body is fetched once
    // across the whole cycle and never flashes back to the loading spinner.
    expect(courseApi.contentBody).toHaveBeenCalledTimes(1);
    expect(queryByTestId('reader-loading')).toBeNull();
    expect(queryByTestId('reader-markdown')).not.toBeNull();
  });

  it('forwards onWriteNote to the reader so the write-note affordance appears', async () => {
    const item = makeItem();
    const onWriteNote = jest.fn();
    const { findByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        onWriteNote={onWriteNote}
        nav={makeNav()}
      />,
    );
    await findByTestId('reader-write-note-affordance');
  });

  it('omits the write-note affordance when onWriteNote is not forwarded', async () => {
    const item = makeItem();
    const { findByTestId, queryByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(queryByTestId('reader-write-note-affordance')).toBeNull();
  });

  it('forwards initialScrollOffset to the reader as the ScrollView contentOffset', async () => {
    const item = makeItem();
    const { findByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        initialScrollOffset={90}
        nav={makeNav()}
      />,
    );
    const scrollView = await findByTestId('reader-markdown');
    expect(scrollView.props.contentOffset).toEqual({ x: 0, y: 90 });
  });

  it('surfaces a retry UI when the content body fails to load', async () => {
    courseApi.contentBody.mockRejectedValueOnce({ detail: 'content_unavailable' });
    const item = makeItem();
    const { findByTestId, getByText, findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-error');
    expect(getByText(/please try again/i)).toBeTruthy();

    courseApi.contentBody.mockResolvedValueOnce({
      title: 'Chapter One',
      content_type: 'chapter',
      body_markdown: 'retry worked\n',
    });
    fireEvent.press(await findByTestId('reader-retry-button'));
    await findByText(/retry worked/);
  });

  it('renders the chapter nav buttons below the mark-read button', async () => {
    const item = makeItem();
    const { findByTestId, getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(getByTestId('chapter-nav-back')).toBeTruthy();
    expect(getByTestId('chapter-nav-next')).toBeTruthy();
  });

  it('calls nav.onNext when the next button is pressed', async () => {
    const onNext = jest.fn();
    const item = makeItem();
    const { findByTestId, getByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        nav={makeNav({ onNext })}
      />,
    );
    await findByTestId('reader-markdown');
    fireEvent.press(getByTestId('chapter-nav-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('calls nav.onPrev when the back button is pressed', async () => {
    const onPrev = jest.fn();
    const item = makeItem();
    const { findByTestId, getByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        nav={makeNav({ onPrev })}
      />,
    );
    await findByTestId('reader-markdown');
    fireEvent.press(getByTestId('chapter-nav-back'));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('disables the chapter nav back button when canPrev is false', async () => {
    const onPrev = jest.fn();
    const item = makeItem();
    const { findByTestId, getByTestId } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        nav={makeNav({ canPrev: false, onPrev })}
      />,
    );
    await findByTestId('reader-markdown');
    const backButton = getByTestId('chapter-nav-back');
    expect(backButton.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(backButton);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('shows Done on the next button when nextIsDone is true', async () => {
    const item = makeItem();
    const { findByTestId, getByTestId, getByText } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        nav={makeNav({ nextIsDone: true })}
      />,
    );
    await findByTestId('reader-markdown');
    expect(getByText('Done')).toBeTruthy();
    expect(getByTestId('chapter-nav-next').props.accessibilityLabel).toBe('Done');
  });

  it('resets read state when navigating to a different, unread chapter', async () => {
    // Chapter one starts unread; the user marks it read (local state → true).
    const chapterOne = makeItem({ id: 1, is_read: false });
    const { getByTestId, getByText, findByTestId, rerender, queryByText } = render(
      <ContentViewer item={chapterOne} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });
    await waitFor(() => {
      expect(getByText('✓ Read')).toBeTruthy();
    });

    // Next → keeps ContentViewer mounted and swaps in an unread chapter two.
    const chapterTwo = makeItem({ id: 2, is_read: false });
    rerender(
      <ContentViewer item={chapterTwo} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );

    // The mark-read UI must reflect chapter two's unread state, not chapter one's.
    await waitFor(() => {
      expect(getByText('Mark as Read')).toBeTruthy();
    });
    expect(queryByText('✓ Read')).toBeNull();
    const markReadButton = getByTestId('mark-read-button');
    expect(markReadButton.props.accessibilityState?.disabled ?? false).toBe(false);
  });

  it('reflects an already-read chapter when navigating back to it', async () => {
    // ContentViewer stays mounted while navigating from an unread chapter to a
    // previously-read one; the read state must follow the incoming item.
    const unread = makeItem({ id: 3, is_read: false });
    const { getByText, findByTestId, rerender, queryByText } = render(
      <ContentViewer item={unread} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );
    await findByTestId('reader-markdown');
    expect(getByText('Mark as Read')).toBeTruthy();

    const alreadyRead = makeItem({ id: 4, is_read: true });
    rerender(
      <ContentViewer item={alreadyRead} onBack={onBack} onMarkRead={onMarkRead} nav={makeNav()} />,
    );

    await waitFor(() => {
      expect(getByText('✓ Read')).toBeTruthy();
    });
    expect(queryByText('Mark as Read')).toBeNull();
  });

  it('shows Next chapter on the next button when nextIsDone is false', async () => {
    const item = makeItem();
    const { findByTestId, getByTestId, getByText } = render(
      <ContentViewer
        item={item}
        onBack={onBack}
        onMarkRead={onMarkRead}
        nav={makeNav({ nextIsDone: false })}
      />,
    );
    await findByTestId('reader-markdown');
    expect(getByText('Next →')).toBeTruthy();
    expect(getByTestId('chapter-nav-next').props.accessibilityLabel).toBe('Next chapter');
  });
});
