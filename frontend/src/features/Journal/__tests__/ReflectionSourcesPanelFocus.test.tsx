/**
 * The Sources panel's keyboard and focus contract, at both of its placements.
 *
 * The panel is a ``Modal`` at every width (#3133): a bottom sheet on a phone, a
 * centred card on a laptop. The Modal's own ``onRequestClose`` carries Escape
 * (web) and the platform back button, so the panel arms no listener of its own
 * -- one request is one close, and a covered screen's panel cannot swallow a
 * back press meant for the screen pushed over it. Focus lands on the X one
 * frame after opening (#3002); closing hands it back to the Sources toggle.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { BackHandler } from 'react-native';

import { spyOnFocus } from './focusSpyTestKit';

import type { ReflectionSourceItem } from '@/api';

const ReflectionSourcesPanel = require('../ReflectionSourcesPanel').default;
const Platform = require('react-native').Platform as { OS: string };

const SOURCE: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Walk',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'By the river.',
  reflection_level: null,
  promoted_quotes: [],
};

/** The phone width, where the panel is a bottom sheet over the page. */
const SHEET_WIDTH = 390;
/** A laptop width, where the panel is a card centred over the desk. */
const MODAL_WIDTH = 1280;
/** The id the stubbed ``requestAnimationFrame`` hands back for the first frame. */
const FIRST_FRAME_ID = 1;

/*
 * #3002 moved the Sources toggle into the exit row, ABOVE the editor: a Tab
 * walk from it to the panel now crosses the whole page (camera, close, tags,
 * title, body, every formatting action, Finish) before the dock. So the panel
 * takes focus on its close control when it opens, one frame late so a web
 * Modal's portal is attached; closing still hands focus back to the toggle.
 */
describe('ReflectionSourcesPanel -- focus lands on the close when it opens (#3002)', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function renderAt(width: number, close?: () => void) {
    const rn = require('react-native');
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
    return render(
      <ReflectionSourcesPanel items={[SOURCE]} onInsertQuote={jest.fn()} onClose={close} />,
    );
  }

  it.each([
    { width: MODAL_WIDTH, frame: 'reflection-sources-modal-body' },
    { width: SHEET_WIDTH, frame: 'reflection-sources-sheet-body' },
  ])('focuses the close one frame after opening, in $frame', ({ width, frame }) => {
    const screen = renderAt(width, jest.fn());
    expect(screen.getByTestId(frame)).toBeTruthy();
    const focus = spyOnFocus(screen.getByTestId('reflection-sources-close'));
    expect(focus).not.toHaveBeenCalled();

    act(() => frames.forEach((run) => run(0)));

    expect(focus).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('takes no focus when the caller offers no close control', () => {
    const screen = renderAt(MODAL_WIDTH);
    expect(screen.queryByTestId('reflection-sources-close')).toBeNull();
    expect(frames).toHaveLength(0);
    screen.unmount();
  });

  it('cancels the pending focus when the panel closes before the frame', () => {
    const screen = renderAt(MODAL_WIDTH, jest.fn());
    expect(frames).toHaveLength(1);
    screen.unmount();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(FIRST_FRAME_ID);
  });
});

describe('ReflectionSourcesPanel -- the centred modal owns Escape and back (#3133)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function renderModal(onClose: () => void) {
    const rn = require('react-native');
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: MODAL_WIDTH, height: 900, scale: 1, fontScale: 1 });
    return render(
      <ReflectionSourcesPanel items={[SOURCE]} onInsertQuote={jest.fn()} onClose={onClose} />,
    );
  }

  it('arms no document Escape listener of its own on web; the Modal request closes it once', () => {
    const globalRef = globalThis as { document?: Document };
    const original = Platform.OS;
    const target = new EventTarget();
    globalRef.document = Object.assign(target, {
      querySelector: () => null,
    }) as unknown as Document;
    const onClose = jest.fn();
    try {
      Platform.OS = 'web';
      const screen = renderModal(onClose);
      const escape = new Event('keydown');
      Object.defineProperty(escape, 'key', { value: 'Escape' });
      act(() => {
        target.dispatchEvent(escape);
      });
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        screen.getByTestId('reflection-sources-modal').props.onRequestClose();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      screen.unmount();
    } finally {
      Platform.OS = original;
      delete globalRef.document;
    }
  });

  it('registers no back handler: the Modal window answers back', () => {
    const add = jest.spyOn(BackHandler, 'addEventListener');
    const onClose = jest.fn();
    const screen = renderModal(onClose);
    expect(add).not.toHaveBeenCalled();
    expect(screen.getByTestId('reflection-sources-modal').props.onRequestClose).toBe(onClose);
  });
});
