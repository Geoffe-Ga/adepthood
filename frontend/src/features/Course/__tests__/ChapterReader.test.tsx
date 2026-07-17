/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import type * as Api from '../../../api';
import { rhythm, surface } from '../../../design/tokens';
import ChapterReader from '../ChapterReader';

interface TestNode {
  props: Record<string, unknown>;
}

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
    // The viewer header and the sheet title both render the live title.
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
    const { findByTestId, findByText, getByText, queryByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/please try again/i);
    expect(getByText('Try again')).toBeTruthy();
    expect(queryByText('Try Again')).toBeNull();
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
    await findByText(/hasn['’]t been written yet/i);
  });

  // A body that is only its duplicate title heading strips down to nothing, so
  // it must fall through to the empty state — not a headed, bodyless sheet.
  it('shows the empty state when the body is only its duplicate title heading', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Chapter One',
      content_type: 'chapter',
      body_markdown: '# Chapter One\n\n',
    });
    const { findByTestId, queryByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-empty');
    expect(queryByTestId('reader-markdown')).toBeNull();
  });

  // An H2 duplicate title heading must also strip down to nothing, not just H1.
  it('shows the empty state when the body is only its duplicate H2 title heading', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Chapter One',
      content_type: 'chapter',
      body_markdown: '## Chapter One\n\n',
    });
    const { findByTestId, queryByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-empty');
    expect(queryByTestId('reader-markdown')).toBeNull();
  });

  // A single in-paragraph newline (soft break) must reflow to a space.
  it('reflows hard-wrapped lines within a paragraph into a single visual line', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Reflow Test',
      content_type: 'chapter',
      body_markdown: 'a crash\ncourse in flow.\n',
    });
    const { findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    // Passes only when the softbreak between 'crash' and 'course' becomes a space.
    await findByText(/crash course/);
  });

  // GREEN guard: blank-line paragraph boundaries must not be collapsed by the softbreak fix.
  it('preserves blank-line paragraph boundaries after the softbreak fix', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Para Boundary',
      content_type: 'chapter',
      body_markdown: 'para one.\n\npara two.\n',
    });
    const { findByText, queryByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/para one/);
    await findByText(/para two/);
    // The two paragraphs must remain separate — not joined into one run of text.
    expect(queryByText(/para one\.\s*para two/)).toBeNull();
  });

  // GREEN guard: list items must remain distinct after the softbreak fix.
  it('renders list items as distinct nodes, not collapsed into one line', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'List Test',
      content_type: 'chapter',
      body_markdown: '- alpha\n- beta\n',
    });
    const { findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    // Both items must be independently queryable.
    await findByText(/alpha/);
    await findByText(/beta/);
  });

  // GREEN guard: a two-trailing-space hard break must NOT be collapsed to a space.
  it('preserves a hard break (two trailing spaces) after the softbreak fix', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Hard Break',
      content_type: 'chapter',
      body_markdown: 'line one  \nline two.\n',
    });
    const { findByText, queryByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/line one/);
    await findByText(/line two/);
    // The hard break must keep them apart — not reflowed into one spaced run.
    expect(queryByText(/line one line two/)).toBeNull();
  });

  it('renders images from absolute URLs and drops repo-relative image references', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Image Test',
      content_type: 'chapter',
      body_markdown:
        '# Image Test\n\n![Good Image](https://example.com/pic.png)\n\n![Bad Image](assets/relative.png)\n',
    });
    const { findByLabelText, queryByLabelText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByLabelText('Good Image');
    expect(queryByLabelText('Bad Image')).toBeNull();
  });

  it('renders the manifest title in the reader sheet header', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const title = await findByTestId('reader-sheet-title');
    expect(title.props.children).toBe('Chapter One');
  });

  it('labels the sheet eyebrow "Chapter" for content sources', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const eyebrow = await findByTestId('reader-sheet-eyebrow');
    expect(eyebrow.props.children).toBe('Chapter');
  });

  it('labels the sheet eyebrow "Resource" for site-resource sources', async () => {
    const { findByTestId } = render(
      <ChapterReader
        source={{ kind: 'resource', slug: 'philosophy' }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    const eyebrow = await findByTestId('reader-sheet-eyebrow');
    expect(eyebrow.props.children).toBe('Resource');
  });

  it('labels the sheet eyebrow "Introduction" for intro sources', async () => {
    const { findByTestId } = render(
      <ChapterReader
        source={{ kind: 'intro', stageNumber: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    const eyebrow = await findByTestId('reader-sheet-eyebrow');
    expect(eyebrow.props.children).toBe('Introduction');
  });

  it('renders no eyebrow for an unmapped content_type', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'X',
      content_type: 'mystery',
      body_markdown: '# X\n\nbody.\n',
    });
    const { findByTestId, queryByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-sheet-title');
    expect(queryByTestId('reader-sheet-eyebrow')).toBeNull();
  });

  it('dedupes a leading H1 that matches the manifest title', async () => {
    const { findByTestId, getAllByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByTestId('reader-sheet-title');
    // Only the viewer header and the sheet title render "Chapter One" -- the
    // leading markdown H1 duplicate is stripped.
    expect(getAllByText('Chapter One')).toHaveLength(2);
  });

  it('preserves a leading H1 that differs from the manifest title', async () => {
    mockContentBody.mockResolvedValueOnce({
      title: 'Manifest Title',
      content_type: 'chapter',
      body_markdown: '# Different Heading\n\nbody.\n',
    });
    const { findByTestId, findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const title = await findByTestId('reader-sheet-title');
    expect(title.props.children).toBe('Manifest Title');
    await findByText('Different Heading');
  });

  it('renders a desk-colored bottom fade beneath the loaded body', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const fade = await findByTestId('reader-bottom-fade');
    const stops = fade.findAll(
      (node: TestNode) => typeof node.props.offset === 'string' && 'stopColor' in node.props,
    );
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(stop.props.stopColor).toBe(surface.desk);
    }
  });

  it('renders the bottom fade as a sibling overlay, never nested inside the markdown ScrollView', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const fade = await findByTestId('reader-bottom-fade');
    const scrollView = await findByTestId('reader-markdown');
    const nestedFade = scrollView.findAll(
      (node: TestNode) => node.props.testID === 'reader-bottom-fade',
    );
    expect(nestedFade).toHaveLength(0);
    expect(fade).toBeTruthy();
  });

  it('pads the markdown ScrollView content by the bottom-fade height', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const scrollView = await findByTestId('reader-markdown');
    const flat = StyleSheet.flatten(scrollView.props.contentContainerStyle);
    expect(flat.paddingBottom).toBe(rhythm.bottomFadeHeight);
  });

  it('still renders a footer alongside the bottom fade once content has loaded', async () => {
    const { findByTestId, findByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
        footer={<Text>FOOTER_HERE</Text>}
      />,
    );
    await findByTestId('reader-bottom-fade');
    await findByText('FOOTER_HERE');
  });
});
