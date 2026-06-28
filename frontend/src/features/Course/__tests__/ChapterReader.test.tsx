/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import type * as Api from '../../../api';
import ChapterReader from '../ChapterReader';

jest.mock('../../../api', () => ({
  course: {
    contentBody: jest.fn(),
    siteResourceBody: jest.fn(),
    stageIntroBody: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    siteResourceBody: jest.MockedFunction<typeof Api.course.siteResourceBody>;
    stageIntroBody: jest.MockedFunction<typeof Api.course.stageIntroBody>;
  };
};

const {
  contentBody: mockContentBody,
  siteResourceBody: mockSiteResourceBody,
  stageIntroBody: mockStageIntroBody,
} = courseApi;

const HAPPY_CHAPTER = {
  title: 'Chapter One',
  content_type: 'chapter',
  body_markdown: '# Chapter One\n\nchapter body with **emphasis**.\n',
};

const HAPPY_RESOURCE = {
  title: 'Philosophy',
  content_type: 'resource',
  body_markdown: '# Philosophy\n\nphilosophy body.\n',
};

const HAPPY_INTRO = {
  title: 'Welcome to Beige',
  content_type: 'introduction',
  body_markdown: '# Welcome to Beige\n\nintro body.\n',
};

describe('ChapterReader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(HAPPY_CHAPTER);
    mockSiteResourceBody.mockResolvedValue(HAPPY_RESOURCE);
    mockStageIntroBody.mockResolvedValue(HAPPY_INTRO);
  });

  it('renders the fallback title until the live one arrives', async () => {
    const onBack = jest.fn();
    const { getByText, findAllByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 7 }}
        fallbackTitle="Loading…"
        onBack={onBack}
      />,
    );
    expect(getByText('Loading…')).toBeTruthy();
    // Header title + the markdown H1 both render the live title.
    await findAllByText('Chapter One');
  });

  it('routes content sources to course.contentBody', async () => {
    render(
      <ChapterReader source={{ kind: 'content', id: 42 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await waitFor(() => expect(mockContentBody).toHaveBeenCalledWith(42));
    expect(mockSiteResourceBody).not.toHaveBeenCalled();
  });

  it('routes resource sources to course.siteResourceBody', async () => {
    render(
      <ChapterReader
        source={{ kind: 'resource', slug: 'philosophy' }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockSiteResourceBody).toHaveBeenCalledWith('philosophy'));
    expect(mockContentBody).not.toHaveBeenCalled();
  });

  it('routes intro sources to course.stageIntroBody and renders the body', async () => {
    const { findAllByText } = render(
      <ChapterReader
        source={{ kind: 'intro', stageNumber: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockStageIntroBody).toHaveBeenCalledWith(1));
    expect(mockContentBody).not.toHaveBeenCalled();
    expect(mockSiteResourceBody).not.toHaveBeenCalled();
    await findAllByText('Welcome to Beige');
  });

  it('shows the error state when an intro body fails to load', async () => {
    mockStageIntroBody.mockRejectedValueOnce({ detail: 'boom' });
    const { findByTestId } = render(
      <ChapterReader
        source={{ kind: 'intro', stageNumber: 2 }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    await findByTestId('reader-error');
  });

  it('renders a footer when one is provided', async () => {
    const { findByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
        footer={<Text>FOOTER_HERE</Text>}
      />,
    );
    await findByText('FOOTER_HERE');
  });

  it('triggers onBack from the header back button', async () => {
    const onBack = jest.fn();
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={onBack} />,
    );
    fireEvent.press(await findByTestId('reader-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders the Markdown body natively — no WebView, no iframe', async () => {
    const { findByTestId, findByText, queryByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-markdown');
    // The markdown text content is rendered as native Text nodes.
    await findByText(/chapter body with/);
    expect(queryByTestId('reader-webview')).toBeNull();
    expect(queryByTestId('reader-iframe')).toBeNull();
  });

  it('shows a generic error and lets the user retry on failure', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'anything' }).mockResolvedValueOnce({
      title: 'After retry',
      content_type: 'chapter',
      body_markdown: 'retried body\n',
    });
    const { findByTestId, findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/please try again/i);
    fireEvent.press(await findByTestId('reader-retry-button'));
    await findByText(/retried body/);
  });

  it('never renders legacy CMS error copy', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_auth_failed' });
    const { findByTestId, queryByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-error');
    expect(queryByText(/site password/i)).toBeNull();
    expect(queryByText(/course site/i)).toBeNull();
  });

  it('shows a friendly empty state for a blank body', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Empty Chapter',
      content_type: 'chapter',
      body_markdown: '   \n',
    });
    const { findByTestId, findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-empty');
    await findByText(/hasn’t been written yet/i);
  });
});
